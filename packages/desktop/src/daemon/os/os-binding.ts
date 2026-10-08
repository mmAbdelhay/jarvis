// The contract §3.1 channels (+ M2 §2 updates:check, M2.5 §2 memory:* and registry:list) as ControlHandlers for the existing control
// server (frames, handshake, lock and run dir unchanged). Every argument is
// parsed by @jarvis/wire's field-by-field parsers before the agent sees it;
// a parse failure or an OsAgentError is a typed refusal, never "internal".
// Local control and phone callers share routing; phone requests are allowlisted.
//
// No electron here (core/no-electron.test.ts).
import { type AuditVia, CONTROL_TEXT, type ConfirmFrom, LOCAL_CONFIRM } from "@jarvis/core";
import {
  OS_CONTROL_REQUESTS,
  type Parsed,
  parseAgentConfirm,
  parseAgentPrompt,
  parseAgentStop,
  parseAuditList,
  parseDoctorSkip,
  parseMemoryDelete,
  parseMemoryList,
  parseMemorySetEnabled,
  parseNoArgs,
  parseProviderDraft,
  parseProviderSave,
} from "@jarvis/wire";
import { ControlRequestError } from "../control/messages.js";
import type { ControlConnection, ControlHandlers } from "../control/server.js";
import { type OsAgent, OsAgentError } from "./agent-service.js";

function value<T>(parsed: Parsed<T>): T {
  if (!parsed.ok) throw new ControlRequestError("bad-request", parsed.error);
  return parsed.value;
}

export type OsOrigin =
  | { kind: "local"; connection: ControlConnection }
  | { kind: "phone"; device: { id: string; name: string } };

/** What the router serves. Later M3 tasks add optional services here. */
export type OsServices = { agent: OsAgent };

export type OsRouter = {
  invoke(channel: string, args: unknown[], origin: OsOrigin): Promise<unknown>;
  upload(channel: string, args: unknown[], bytes: Uint8Array, origin: OsOrigin): Promise<unknown>;
};

/** Rafiq M3 §2: the request channels a paired phone may call. Everything
 *  else is refused here too, whatever the bridge's own policy says. */
export const PHONE_REQUESTS: ReadonlySet<string> = new Set([
  OS_CONTROL_REQUESTS.agentPrompt,
  OS_CONTROL_REQUESTS.agentStop,
  OS_CONTROL_REQUESTS.agentConfirm,
  OS_CONTROL_REQUESTS.agentUndo,
  OS_CONTROL_REQUESTS.auditList,
  OS_CONTROL_REQUESTS.memoryList,
]);

const MAX_PHONE_NAME = 64;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this removes.
const NAME_CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

export function phoneDeviceName(raw: string): string {
  const name = raw
    .replace(NAME_CONTROL, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_PHONE_NAME)
    .trim();
  return name === "" ? "phone" : name;
}

export function phoneVia(name: string): AuditVia {
  return `phone:${phoneDeviceName(name)}`;
}

export function confirmFrom(origin: OsOrigin): ConfirmFrom {
  return origin.kind === "local"
    ? LOCAL_CONFIRM
    : { via: phoneVia(origin.device.name), allowPassword: false };
}

export function requireLocal(origin: OsOrigin): void {
  if (origin.kind !== "local") throw new ControlRequestError("forbidden", CONTROL_TEXT.localOnly);
}

export function createOsRouter(services: OsServices): OsRouter {
  const { agent } = services;

  async function route(channel: string, args: unknown[], _origin: OsOrigin): Promise<unknown> {
    switch (channel) {
      case OS_CONTROL_REQUESTS.agentPrompt:
        return agent.prompt(value(parseAgentPrompt(args)).text);
      case OS_CONTROL_REQUESTS.agentStop:
        return agent.stop(value(parseAgentStop(args)).turnId);
      case OS_CONTROL_REQUESTS.agentConfirm:
        return agent.confirm(value(parseAgentConfirm(args)));
      case OS_CONTROL_REQUESTS.providerList:
        value(parseNoArgs(args));
        return agent.providerList();
      case OS_CONTROL_REQUESTS.providerProbe:
        return agent.probe(value(parseProviderDraft(args)));
      case OS_CONTROL_REQUESTS.providerSave:
        return agent.save(value(parseProviderSave(args)));
      case OS_CONTROL_REQUESTS.doctorStart:
        value(parseNoArgs(args));
        return agent.doctorStart();
      case OS_CONTROL_REQUESTS.doctorSkip:
        return agent.doctorSkip(value(parseDoctorSkip(args)).stepId);
      case OS_CONTROL_REQUESTS.auditList:
        return agent.auditList(value(parseAuditList(args)));
      case OS_CONTROL_REQUESTS.updatesCheck:
        value(parseNoArgs(args));
        return agent.checkUpdates();
      case OS_CONTROL_REQUESTS.registryList:
        value(parseNoArgs(args));
        return agent.registryList();
      case OS_CONTROL_REQUESTS.memoryList:
        return agent.memoryList(value(parseMemoryList(args)).limit);
      case OS_CONTROL_REQUESTS.memoryDelete:
        return agent.memoryDelete(value(parseMemoryDelete(args)).id);
      case OS_CONTROL_REQUESTS.memoryClear:
        value(parseNoArgs(args));
        return agent.memoryClear();
      case OS_CONTROL_REQUESTS.memorySetEnabled:
        return agent.memorySetEnabled(value(parseMemorySetEnabled(args)).enabled);
      default:
        throw new ControlRequestError("unknown-channel", `No handler for ${channel}`);
    }
  }

  async function routeBlob(
    channel: string,
    _args: unknown[],
    _bytes: Uint8Array,
    _origin: OsOrigin,
  ): Promise<unknown> {
    switch (channel) {
      default:
        throw new ControlRequestError("unsupported", `No upload channel ${channel} is served here`);
    }
  }

  async function translate(run: () => Promise<unknown>): Promise<unknown> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof OsAgentError) throw new ControlRequestError(error.code, error.message);
      throw error;
    }
  }

  return {
    invoke(channel, args, origin) {
      if (origin.kind === "phone" && !PHONE_REQUESTS.has(channel)) {
        return Promise.reject(new ControlRequestError("forbidden", CONTROL_TEXT.localOnly));
      }
      return translate(() => route(channel, args, origin));
    },
    upload(channel, args, bytes, origin) {
      return translate(() => routeBlob(channel, args, bytes, origin));
    },
  };
}

export function createOsBinding(
  router: OsRouter,
  deps: { requestStop(): void; defer(callback: () => void): void },
): ControlHandlers {
  return {
    invoke: (channel, args, connection) =>
      router.invoke(channel, args, { kind: "local", connection }),
    upload: (channel, args, bytes, connection) =>
      router.upload(channel, args, bytes, { kind: "local", connection }),
    stop() {
      deps.defer(deps.requestStop);
    },
  };
}
