// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AnchoredComment, PlanBlock, PlanComment } from "@jarvis/core";
import type { PlanDoc, PlanList, PlanResult } from "@jarvis/platform";
import { createPlanPanel, type PlanPanelApi } from "./plan-panel.js";

const blocks: PlanBlock[] = [
  {
    id: "heading-1",
    kind: "heading",
    level: 1,
    start: 0,
    end: 1,
    source: "# Build it",
    html: "<h1>Build it</h1>",
  },
  {
    id: "paragraph-1",
    kind: "paragraph",
    start: 1,
    end: 2,
    source: "Ship the useful feature safely.",
    html: "<p>Ship the useful feature safely.</p>",
  },
];

const doc: PlanDoc = {
  path: "/repo/docs/superpowers/plans/build.md",
  mtimeMs: 1_700_000_000_000,
  blocks,
};

function entry(
  path: string,
  name: string,
  source: "session" | "planMode" | "repo",
  extra: Record<string, unknown> = {},
) {
  return { path, name, source, mtimeMs: 1_700_000_000_000, ...extra };
}

const list: PlanList = {
  session: entry("/tmp/session.md", "session.md", "session"),
  planMode: [entry("/tmp/alpha.md", "Alpha plan.md", "planMode", { project: "jarvis" })],
  repo: [entry(doc.path, "build.md", "repo", { repoKind: "plan" })],
};

function comment(overrides: Partial<AnchoredComment> = {}): AnchoredComment {
  return {
    id: "comment-1",
    path: doc.path,
    blockId: "paragraph-1",
    quote: "useful feature",
    body: "Make the rollout explicit.",
    createdAt: 1,
    number: 1,
    anchor: { kind: "block", blockId: "paragraph-1", text: "Ship the useful feature safely." },
    ...overrides,
  };
}

function fakeApi(overrides: Partial<PlanPanelApi> = {}): PlanPanelApi {
  return {
    plansList: vi.fn(async () => list),
    plansRead: vi.fn(async (): Promise<PlanResult<PlanDoc>> => ({ ok: true, value: doc })),
    plansWriteBlock: vi.fn(async (): Promise<PlanResult<PlanDoc>> => ({ ok: true, value: doc })),
    plansComments: vi.fn(async () => []),
    plansAddComment: vi.fn(
      async (_path, blockId, quote, body): Promise<PlanComment> => ({
        id: "new-comment",
        path: doc.path,
        blockId,
        quote,
        body,
        createdAt: 2,
      }),
    ),
    plansUpdateComment: vi.fn(async () => undefined),
    plansDeleteComment: vi.fn(async () => true),
    plansSend: vi.fn(async () => ({ ok: true as const, sent: 0 })),
    ...overrides,
  };
}

function setup(api = fakeApi()) {
  const panel = createPlanPanel({ api, t: (key) => key });
  document.body.append(panel.element);
  panel.setPane("pane-1", "/repo");
  return { panel, api };
}

function click(target: Element | null): void {
  if (!target) throw new Error("missing click target");
  target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("createPlanPanel", () => {
  it("renders plan blocks and toggles the read-only source", async () => {
    const { panel } = setup();
    await panel.open(doc.path);

    expect(panel.element.querySelectorAll(".plan-block")).toHaveLength(2);
    expect(panel.element.querySelector('[data-block-id="paragraph-1"]')?.textContent).toContain(
      "Ship the useful feature safely.",
    );
    click(panel.element.querySelector('[data-action="source"]'));
    expect(panel.element.querySelector("pre")?.textContent).toBe(
      "# Build it\nShip the useful feature safely.",
    );
  });

  it("replaces remote images with alt text but keeps data images", async () => {
    const imageDoc: PlanDoc = {
      ...doc,
      blocks: [
        {
          ...blocks[1]!,
          html: '<p><img src="https://tracker.invalid/pixel.png" alt="diagram"><img src="data:image/png;base64,AA" alt="inline"></p>',
        },
      ],
    };
    const api = fakeApi({ plansRead: vi.fn(async () => ({ ok: true as const, value: imageDoc })) });
    const { panel } = setup(api);
    await panel.open(doc.path);

    const images = panel.element.querySelectorAll("img");
    expect(images).toHaveLength(1);
    expect(images[0]?.getAttribute("src")).toBe("data:image/png;base64,AA");
    expect(panel.element.textContent).toContain("diagram");
  });

  it("highlights a quoted comment when its text spans inline markup", async () => {
    const markedUpDoc: PlanDoc = {
      ...doc,
      blocks: [
        {
          ...blocks[1]!,
          html: "<p>Ship the <strong>useful</strong> feature safely.</p>",
        },
      ],
    };
    const api = fakeApi({
      plansRead: vi.fn(async () => ({ ok: true as const, value: markedUpDoc })),
      plansComments: vi.fn(async () => [comment()]),
    });
    const { panel } = setup(api);
    await panel.open(doc.path);

    const highlight = panel.element.querySelector("mark.plan-quote");
    expect(highlight?.textContent).toBe("useful feature");
    expect(highlight?.querySelector("strong")?.textContent).toBe("useful");
  });

  it("groups picker entries, filters by name, and opens the active result with Enter", async () => {
    const { panel, api } = setup();
    await panel.open(doc.path);
    click(panel.element.querySelector(".plan-panel__file"));

    expect(panel.element.textContent).toContain("planPickerSession");
    expect(panel.element.textContent).toContain("planPickerRecent");
    expect(panel.element.textContent).toContain("planPickerRepo");
    const search = panel.element.querySelector<HTMLInputElement>(
      '.plan-panel__picker input[type="search"]',
    )!;
    search.value = "alpha";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    expect(panel.element.querySelectorAll(".plan-panel__picker-item")).toHaveLength(1);
    search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await settle();
    expect(api.plansRead).toHaveBeenLastCalledWith("/tmp/alpha.md");
  });

  it("opens an empty state when this pane has no session plan", async () => {
    const api = fakeApi({
      plansList: vi.fn(async () => ({ session: undefined, planMode: [], repo: [] })),
    });
    const { panel } = setup(api);
    await panel.open();
    expect(panel.element.textContent).toContain("planEmptyTitle");
    expect(panel.element.textContent).toContain("planEmptyHint");
  });

  it("adds a comment for a text selection inside one block", async () => {
    const { panel, api } = setup();
    await panel.open(doc.path);
    const text = panel.element.querySelector('[data-block-id="paragraph-1"] p')?.firstChild;
    const range = document.createRange();
    range.setStart(text!, 9);
    range.setEnd(text!, 23);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));

    click(panel.element.querySelector('[data-action="comment-selection"]'));
    const textarea = panel.element.querySelector<HTMLTextAreaElement>(
      ".plan-panel__comment-box textarea",
    )!;
    textarea.value = "Clarify this.";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    click(panel.element.querySelector('[data-action="add-comment"]'));
    await settle();

    expect(api.plansAddComment).toHaveBeenCalledWith(
      doc.path,
      "paragraph-1",
      "useful feature",
      "Clarify this.",
    );
  });

  it("opens a pin popover and deletes its comment", async () => {
    const api = fakeApi({ plansComments: vi.fn(async () => [comment()]) });
    const { panel } = setup(api);
    await panel.open(doc.path);
    click(panel.element.querySelector(".plan-panel__pin"));
    expect(panel.element.textContent).toContain("Make the rollout explicit.");
    click(panel.element.querySelector('[data-action="delete-comment"]'));
    await settle();
    expect(api.plansDeleteComment).toHaveBeenCalledWith("comment-1");
  });

  it("shows tray counts and sends only queued comment ids", async () => {
    const comments = [comment(), comment({ id: "sent", number: 2, sentAt: 3 })];
    const api = fakeApi({ plansComments: vi.fn(async () => comments) });
    const { panel } = setup(api);
    await panel.open(doc.path);

    expect(panel.element.querySelector(".plan-panel__tray-summary")?.textContent).toContain("2");
    expect(panel.element.querySelector(".plan-panel__tray-summary")?.textContent).toContain("1");
    click(panel.element.querySelector('[data-action="send-comments"]'));
    await settle();
    expect(api.plansSend).toHaveBeenCalledWith("pane-1", doc.path, ["comment-1"]);
  });

  it("disables Send when there are no queued comments", async () => {
    const api = fakeApi({ plansComments: vi.fn(async () => [comment({ sentAt: 3 })]) });
    const { panel } = setup(api);
    await panel.open(doc.path);
    expect(
      panel.element.querySelector<HTMLButtonElement>('[data-action="send-comments"]')?.disabled,
    ).toBe(true);
  });

  it("lists orphaned comments at the bottom with the changed-section label", async () => {
    const comments = [
      comment(),
      comment({ id: "orphan", number: 2, anchor: { kind: "orphaned" }, body: "Old section note" }),
    ];
    const api = fakeApi({ plansComments: vi.fn(async () => comments) });
    const { panel } = setup(api);
    await panel.open(doc.path);
    const orphan = panel.element.querySelector(".plan-panel__orphaned");
    expect(orphan?.textContent).toContain("planSectionChanged");
    expect(orphan?.textContent).toContain("Old section note");
    expect(orphan).toBe(panel.element.querySelector(".plan-panel__tray-list")?.lastElementChild);
  });

  it("refreshes the list and current document when notified of its path", async () => {
    const { panel, api } = setup();
    await panel.open(doc.path);
    panel.notifyChanged(doc.path);
    await settle();
    expect(api.plansList).toHaveBeenCalledTimes(2);
    expect(api.plansRead).toHaveBeenCalledTimes(2);
  });
});
