// The contract §3.1 channels as ControlHandlers for the existing control
// server (frames, handshake, lock and run dir unchanged). Every argument is
// parsed by @jarvis/wire's field-by-field parsers before the agent sees it;
// a parse failure or an OsAgentError is a typed refusal, never "internal".
// Reachable only over the 0600 control socket — never the remote bridge.
//
// No electron here (core/no-electron.test.ts).
import {
  OS_CONTROL_REQUESTS,
  type Parsed,
  parseAgentConfirm,
  parseAgentPrompt,
  parseAgentStop,
  parseAuditList,
  parseDoctorSkip,
  parseNoArgs,
  parseProviderDraft,
} from "@jarvis/wire";
import { ControlRequestError } from "../control/messages.js";
import type { ControlHandlers } from "../control/server.js";
import { type OsAgent, OsAgentError } from "./agent-service.js";

function value<T>(parsed: Parsed<T>): T {
  if (!parsed.ok) throw new ControlRequestError("bad-request", parsed.error);
  return parsed.value;
}

export function createOsBinding(
  agent: OsAgent,
  deps: { requestStop(): void; defer(callback: () => void): void },
): ControlHandlers {
  async function route(channel: string, args: unknown[]): Promise<unknown> {
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
      case OS_CONTROL_REQUESTS.providerSave: {
        const draft = value(parseProviderDraft(args));
        // "" is only for provider:probe's list-models mode (contracts §6 #10).
        if (draft.model === "")
          throw new ControlRequestError("bad-request", "model must not be empty when saving");
        return agent.save(draft);
      }
      case OS_CONTROL_REQUESTS.doctorStart:
        value(parseNoArgs(args));
        return agent.doctorStart();
      case OS_CONTROL_REQUESTS.doctorSkip:
        return agent.doctorSkip(value(parseDoctorSkip(args)).stepId);
      case OS_CONTROL_REQUESTS.auditList:
        return agent.auditList(value(parseAuditList(args)));
      default:
        throw new ControlRequestError("unknown-channel", `No handler for ${channel}`);
    }
  }

  return {
    async invoke(channel, args) {
      try {
        return await route(channel, args);
      } catch (error) {
        if (error instanceof OsAgentError) throw new ControlRequestError(error.code, error.message);
        throw error;
      }
    },
    async upload() {
      throw new ControlRequestError("unsupported", "No upload channel is served here");
    },
    stop() {
      deps.defer(deps.requestStop);
    },
  };
}
