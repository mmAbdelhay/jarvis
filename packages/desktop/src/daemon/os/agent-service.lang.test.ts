import { languageRule, USER_TEXT } from "@jarvis/core";
import { describe, expect, it } from "vitest";
import { OsAgentError } from "./agent-service.js";
import { CONFIG_PATH, DONE, scripted, startAgent } from "./__fixtures__/os-agent-harness.js";

const LOCAL = "ollama http://127.0.0.1:11434 qwen3:8b";
const YAML = `os:
  providers:
    - { id: local, kind: ollama, baseUrl: http://127.0.0.1:11434, model: qwen3:8b }
`;
const languages = (pushed: { channel: string; payload: unknown }[]) =>
  pushed.filter((p) => p.channel === "ui:language").map((p) => p.payload);

describe("jarvisd's UI language (M4 §3)", () => {
  it("starts in the session language and pushes it first on a new connection", async () => {
    const { agent, pushed } = await startAgent({
      yaml: YAML,
      overrides: { defaultLanguage: "ar" },
    });
    expect(agent.language()).toBe("ar");
    pushed.length = 0;
    agent.resync();
    expect(pushed[0]).toEqual({ channel: "ui:language", payload: { lang: "ar" } });
  });

  it("lets os.language in jarvis.yaml win over the session language", async () => {
    const { agent } = await startAgent({
      yaml: `${YAML}  language: en\n`,
      overrides: { defaultLanguage: "ar" },
    });
    expect(agent.language()).toBe("en");
  });

  it("ignores an unknown os.language; the providers still load", async () => {
    const provider = scripted([]);
    const { agent } = await startAgent({
      yaml: `${YAML}  language: fr\n`,
      providers: { [LOCAL]: provider },
      overrides: { defaultLanguage: "ar" },
    });
    expect(agent.language()).toBe("ar");
    expect((await agent.providerList()).providers.map((p) => p.id)).toEqual(["local"]);
  });

  it("ui:setLanguage writes os.language, keeps the providers and tells every client", async () => {
    const { agent, files, pushed } = await startAgent({ yaml: YAML });
    await agent.setLanguage("ar");
    expect(files.get(CONFIG_PATH)).toContain("language: ar");
    expect(files.get(CONFIG_PATH)).toContain("id: local");
    expect(languages(pushed)).toEqual([{ lang: "ar" }]);
    expect(agent.language()).toBe("ar");
  });

  it("an Arabic prompt on an English system gets the Arabic rule", async () => {
    const provider = scripted([[{ type: "text", delta: "تم" }, DONE]]);
    const { agent, waitFor } = await startAgent({ yaml: YAML, providers: { [LOCAL]: provider } });
    const { turnId } = agent.prompt("ثبّت لي vlc");
    await waitFor((e) => e.type === "turn-end" && e.turnId === turnId);
    expect(provider.requests[0]?.system).toContain(languageRule("ar"));
  });

  it("refuses a second prompt in the UI language", async () => {
    const provider = scripted([]);
    const { agent } = await startAgent({
      yaml: `${YAML}  language: ar\n`,
      providers: { [LOCAL]: provider },
    });
    agent.prompt("first");
    expect(() => agent.prompt("second")).toThrow(
      new OsAgentError("bad-request", USER_TEXT.ar.turnRunning),
    );
  });
});
