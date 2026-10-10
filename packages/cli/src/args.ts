// The `jarvis` command line (Rafiq M2.5 contracts §5): chat, ask, setup, memory.
import { ACCOUNT_IDS, type AccountId, isAccountId, MAX_PROMPT_CHARS } from "@jarvis/wire";

export type Command =
  | { kind: "chat" }
  | { kind: "ask"; text: string }
  | { kind: "setup" }
  | { kind: "memory"; action: "list" | "clear"; yes: boolean }
  | { kind: "account"; action: "status" | "install" | "login" | "logout" | "remove"; account?: AccountId }
  | { kind: "help" }
  | { kind: "version" };

export type Parsed = Command | { kind: "usage-error"; message: string };

export const USAGE = `Usage:
  jarvis                       chat with Jarvis
  jarvis ask "<question>"      ask one question, then exit
  jarvis setup                 choose the model providers Jarvis uses, in order
  jarvis memory [list]         show what Jarvis remembers
  jarvis memory clear [--yes]  forget everything Jarvis remembers
  jarvis account               show the accounts Jarvis can sign in with
  jarvis account install <name> set up the account program
  jarvis account login <name>  set up and sign in (claude, chatgpt, gemini, copilot)
  jarvis account logout <name> sign out and delete that account's login
  jarvis account remove <name> sign out and remove the program
  jarvis --help | --version
`;

const YES_FLAGS = new Set(["--yes", "-y"]);

export function parseArgs(argv: readonly string[]): Parsed {
  const [first, ...rest] = argv;
  if (first === undefined) return { kind: "chat" };
  if (first === "--help" || first === "-h" || first === "help") return { kind: "help" };
  if (first === "--version" || first === "-V") return { kind: "version" };
  if (first === "ask") {
    const text = rest.join(" ").trim();
    if (text === "") {
      return {
        kind: "usage-error",
        message: 'jarvis ask needs a question, for example: jarvis ask "what is using my disk?"',
      };
    }
    if (text.length > MAX_PROMPT_CHARS) {
      return {
        kind: "usage-error",
        message: "That question is too long (8000 characters at most).",
      };
    }
    return { kind: "ask", text };
  }
  if (first === "setup") return rest.length === 0 ? { kind: "setup" } : unknown(rest[0]);
  if (first === "account") {
    const [action = "status", name] = rest;
    if (rest.length > 2) return unknown(rest[2]);
    if (action === "status" && name === undefined) return { kind: "account", action: "status" };
    if (action !== "install" && action !== "login" && action !== "logout" && action !== "remove") {
      return { kind: "usage-error", message: `Unknown account action "${action}".` };
    }
    if (!isAccountId(name)) {
      return { kind: "usage-error", message: `jarvis account ${action} needs one of: ${ACCOUNT_IDS.join(", ")}` };
    }
    return { kind: "account", action, account: name };
  }

  if (first === "memory") {
    const action = rest[0] ?? "list";
    if (action !== "list" && action !== "clear") return unknown(action);
    const flags = rest.slice(1);
    const stray = flags.find((flag) => !YES_FLAGS.has(flag));
    if (stray !== undefined) return unknown(stray);
    const yes = flags.length > 0;
    if (action === "list") return yes ? unknown(flags[0]) : { kind: "memory", action, yes: false };
    return { kind: "memory", action: "clear", yes };
  }
  return unknown(first);
}

function unknown(word: string | undefined): Parsed {
  return { kind: "usage-error", message: `Unknown argument: ${word ?? ""}` };
}
