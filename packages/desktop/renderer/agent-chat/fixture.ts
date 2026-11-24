// Shared doubles for the chat's tests: a clock the test steps by hand, an api
// whose every call is a mock, and an agent view in the shape main sends.
import type { ChatItem, ChatToolItem } from "@jarvis/platform";
import { type Mock, vi } from "vitest";
import { MESSAGES, type MessageKey } from "../../src/messages.js";
import { type AgentChat, type AgentChatOptions, createAgentChat } from "../agent-chat.js";
import type { AgentChatView, AgentOf } from "./agent-types.js";

export const NONE: AgentChatView = { kind: "none" };

export const CAPS_CLAUDE: AgentOf["caps"] = {
  stop: true,
  mode: true,
  model: "command",
  commands: true,
  files: true,
  attach: true,
  queue: true,
};

export const user = (id: string, text: string, at?: number): ChatItem => ({
  id,
  kind: "user",
  text,
  ...(at === undefined ? {} : { at }),
});
export const reply = (id: string, text: string, at?: number): ChatItem => ({
  id,
  kind: "text",
  text,
  ...(at === undefined ? {} : { at }),
});
export const tool = (
  id: string,
  name: string,
  extra: Partial<ChatToolItem> = {},
): ChatToolItem => ({
  id,
  kind: "tool",
  tool: name,
  state: "ok",
  ...extra,
});

export function agentView(overrides: Partial<AgentOf> = {}): AgentOf {
  return {
    kind: "agent",
    vendor: "anthropic",
    sessionId: "s1",
    model: "claude-opus-4-5-20251101",
    mode: "plan",
    page: {
      items: [
        user("u1", "fix the build"),
        tool("t1", "Edit", {
          path: "/repo/app.ts",
          target: "app.ts",
          diff: [
            { sign: "-", text: "old line" },
            { sign: "+", text: "new line" },
            { sign: "+", text: "second" },
          ],
        }),
        reply("a1", "On it. **Done** with `code`."),
      ],
    },
    agents: [],
    files: [],
    caps: CAPS_CLAUDE,
    ...overrides,
  };
}

/** A clock the test steps by hand. */
export function clock() {
  let now = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let next = 0;
  return {
    schedule: (fn: () => void, ms: number) => {
      const id = next++;
      timers.set(id, { at: now + ms, fn });
      return () => void timers.delete(id);
    },
    advance(ms: number) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(id);
          timer.fn();
        }
      }
    },
    pending: () => timers.size,
    now: () => now,
  };
}

export const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
export const t = (key: MessageKey): string => (MESSAGES[key] as (l: "en" | "ar") => string)("en");

export function memoryStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    store,
  };
}

// biome-ignore lint/suspicious/noExplicitAny: a test double takes whatever its test gives it.
type AnyMock = Mock<(...args: any[]) => any>;

export type Setup = {
  host: HTMLElement;
  api: Record<
    | "terminalAgentChat"
    | "terminalAgentAnswer"
    | "terminalAgentSend"
    | "terminalAgentStop"
    | "terminalAgentMode"
    | "terminalAgentCommand"
    | "terminalAgentCommands"
    | "terminalAgentFiles"
    | "terminalAgentAttach"
    | "terminalAgentOpenFile"
    | "plansOpenLink"
    | "pathForFile",
    AnyMock
  >;
  chat: AgentChat;
  timers: ReturnType<typeof clock>;
  setChatView: AnyMock;
  focusTerm: AnyMock;
  storage: ReturnType<typeof memoryStorage>;
  q<T extends Element>(selector: string): T;
  current: { view: AgentChatView | (() => AgentChatView) };
  copy: AnyMock;
  xterm: HTMLTextAreaElement;
};

export function setup(
  overrides: Partial<AgentChatOptions> = {},
  view: AgentChatView | (() => AgentChatView) = NONE,
): Setup {
  const host = document.createElement("div");
  // The pane's own live terminal, which the drawer lays over a question.
  const live = document.createElement("div");
  live.className = "terminal-live";
  const xterm = document.createElement("textarea");
  xterm.className = "xterm-helper-textarea";
  live.append(xterm);
  host.append(live);
  document.body.append(host);
  const timers = clock();
  const current = { view };
  const api = {
    terminalAgentChat: vi.fn(async (_paneKey: string, _request?: { before?: string }) =>
      typeof current.view === "function" ? current.view() : current.view,
    ),
    terminalAgentAnswer: vi.fn(async () => ({ ok: true as const })),
    terminalAgentSend: vi.fn(async (_paneKey: string, _text: string) => ({
      ok: true as const,
    })) as unknown as AgentChatOptions["api"]["terminalAgentSend"],
    terminalAgentStop: vi.fn(async () => ({ ok: true as const })),
    terminalAgentMode: vi.fn(async (_paneKey: string, mode: string) => ({
      ok: true as const,
      mode,
    })) as unknown as AgentChatOptions["api"]["terminalAgentMode"],
    terminalAgentCommand: vi.fn(async () => ({ ok: true as const })),
    terminalAgentCommands: vi.fn(async () => ({
      commands: [
        { name: "compact", description: "Shorten the conversation", source: "built-in" as const },
        { name: "clear", description: "Start again", source: "built-in" as const },
        { name: "review", source: "built-in" as const },
      ],
    })),
    terminalAgentFiles: vi.fn(async (_paneKey: string, _query: string) => ({
      files: [
        { path: "src/cart/total.js", name: "total.js" },
        { path: "src/cart/total.test.js", name: "total.test.js" },
      ],
    })),
    terminalAgentAttach: vi.fn(async (_paneKey: string, file: { name: string }) => ({
      ok: true as const,
      path: `/private/${file.name}`,
      name: file.name,
      kind: "image" as const,
      ref: `/private/${file.name}`,
    })),
    terminalAgentOpenFile: vi.fn(async () => ({ ok: true as const })),
    plansOpenLink: vi.fn(async () => undefined),
    pathForFile: vi.fn((_file: File) => ""),
  } satisfies Record<string, unknown>;
  const setChatView = vi.fn();
  const focusTerm = vi.fn();
  const storage = memoryStorage();
  const copy = vi.fn();
  const chat = createAgentChat({
    paneKey: "t1",
    host,
    api: api as unknown as AgentChatOptions["api"],
    t,
    setChatView,
    focusTerm,
    chatKey: () => true,
    schedule: timers.schedule,
    now: timers.now,
    storage,
    isShown: () => true,
    copy,
    ...overrides,
  });
  const q = <T extends Element>(selector: string): T => {
    const found = host.querySelector<T>(selector);
    if (found === null) throw new Error(`missing ${selector}`);
    return found;
  };
  return {
    host,
    api: api as unknown as Setup["api"],
    chat,
    timers,
    setChatView,
    focusTerm,
    storage,
    q,
    current,
    copy,
    xterm,
  };
}

export function tab(host: HTMLElement, mode: "chat" | "term"): HTMLButtonElement {
  const found = host.querySelector<HTMLButtonElement>(`[role="tab"][data-mode="${mode}"]`);
  if (found === null) throw new Error("no tab");
  return found;
}

/** An agent found, and the Chat tab chosen. */
export async function open(
  view: AgentChatView = agentView(),
  overrides: Partial<AgentChatOptions> = {},
): Promise<Setup> {
  const s = setup(overrides, view);
  s.chat.focused();
  await settle();
  tab(s.host, "chat").click();
  return s;
}

export function press(target: Element, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

export function typeInto(s: Setup, text: string): HTMLTextAreaElement {
  const input = s.q<HTMLTextAreaElement>(".agent-chat__input");
  input.value = text;
  input.setSelectionRange(text.length, text.length);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  return input;
}

/** Sets the geometry jsdom does not compute. */
export function geometry(
  node: HTMLElement,
  initial: { scrollHeight: number; clientHeight: number; scrollTop: number },
) {
  const state = { ...initial };
  for (const key of Object.keys(state) as (keyof typeof state)[]) {
    Object.defineProperty(node, key, {
      configurable: true,
      get: () => state[key],
      set: (value: number) => {
        state[key] = value;
      },
    });
  }
  return state;
}
