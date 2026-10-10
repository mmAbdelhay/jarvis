// The local vision probe (v1.1 contracts §3): a catalog model may say
// vision: true only if Ollama reports the "vision" and "tools" capabilities
// AND, given a screenshot and a click tool, it clicks the red button in at
// least two of three screenshots, in pixel coordinates of the image (the
// space jarvis-cu's capture uses). Run by os-models.yml (input "vision").
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OLLAMA_NUM_CTX } from "@jarvis/platform/model";
import {
  PROBE_HEIGHT,
  PROBE_TARGETS,
  PROBE_WIDTH,
  type Click,
  type Target,
  hits,
  readClick,
  targetPng,
  verdict,
} from "./vision-fixture";

const tag = process.env.VISION_MODEL_TAG ?? "";
const baseUrl = process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";
const out = process.env.VISION_PROBE_OUT ?? "";

const CLICK_TOOL = {
  type: "function",
  function: {
    name: "click",
    description:
      "Click a point on the screenshot. x and y are pixel coordinates in the screenshot; (0,0) is the top-left corner.",
    parameters: {
      type: "object",
      properties: { x: { type: "integer" }, y: { type: "integer" } },
      required: ["x", "y"],
    },
  },
};

type ShowReply = { capabilities?: string[] };
type ChatReply = {
  message?: { tool_calls?: { function?: { name?: string; arguments?: unknown } }[] };
};

async function post<T>(path: string, body: unknown, timeoutMs: number): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}

describe.skipIf(tag === "")("vision probe", () => {
  // Invalidate an earlier run before any request can hang or be interrupted.
  if (tag !== "" && out !== "") {
    writeFileSync(
      out,
      `${JSON.stringify({ tag, status: "failed", capabilities: [], trials: [], contextSize: OLLAMA_NUM_CTX }, null, 2)}\n`,
    );
  }
  // Both checks use one capability response; a failed check cannot be
  // overwritten by a later, successful /api/show request.
  let showReply: Promise<ShowReply> | undefined;
  const showModel = () => (showReply ??= post<ShowReply>("/api/show", { model: tag }, 60_000));

  it(`${tag} reports the vision and tools capabilities`, async () => {
    const show = await showModel();
    expect(show.capabilities ?? []).toEqual(expect.arrayContaining(["vision", "tools"]));
  });

  it(`${tag} clicks the red button in a screenshot`, async () => {
    const trials: { target: Target; click: Click | null; hit: boolean }[] = [];
    let capabilities: string[] = [];
    let status: "passed" | "failed" = "failed";
    try {
      const show = await showModel();
      capabilities = show.capabilities ?? [];
      expect(capabilities).toEqual(expect.arrayContaining(["vision", "tools"]));
      for (const target of PROBE_TARGETS) {
        const reply = await post<ChatReply>(
          "/api/chat",
          {
            model: tag,
            stream: false,
            options: { temperature: 0, num_ctx: OLLAMA_NUM_CTX },
            tools: [CLICK_TOOL],
            messages: [
              {
                role: "system",
                content: "You operate a computer by calling tools. Answer only with a tool call.",
              },
              {
                role: "user",
                content: `This screenshot is ${PROBE_WIDTH}x${PROBE_HEIGHT} pixels. Click the centre of the red button.`,
                images: [targetPng(target).toString("base64")],
              },
            ],
          },
          600_000,
        );
        const call = reply.message?.tool_calls?.find((c) => c.function?.name === "click");
        const click = readClick(call?.function?.arguments);
        trials.push({ target, click, hit: hits(click, target) });
      }
      status = verdict(trials.map((t) => t.hit));
      expect(status, JSON.stringify(trials)).toBe("passed");
    } finally {
      // Even a capability or HTTP failure replaces stale passing evidence.
      if (out !== "") {
        writeFileSync(
          out,
          `${JSON.stringify({ tag, status, capabilities, trials, contextSize: OLLAMA_NUM_CTX }, null, 2)}\n`,
        );
      }
    }
  }, 1_900_000);
});
