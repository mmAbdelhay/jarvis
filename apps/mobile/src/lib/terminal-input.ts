// M9 Task 7: a Workspace terminal pane's raw input, on the exact same
// reject-not-queue/no-replay/debounced-resize machinery M7's SessionInput
// already proved out — see session-input.ts's `createRawInput`, which this
// is a thin wrapper over. The only differences from a session's own input
// are the channel names and the id itself (`paneKey`, not `sessionId`):
// `terminal:input`/`terminal:resize`, per task-7-brief.md's interface line
// and remote-policy.ts's terminal:* rows. M7 ruling 3 still applies
// unchanged here: the phone never appends Enter on its own — ⏎ is sent only
// as its own key.

import type { Clock } from "./clock";
import type { RpcClient } from "./rpc-client";
import { createRawInput, type SessionInput } from "./session-input";

export function createTerminalInput(deps: {
  client: RpcClient;
  paneKey: string;
  clock: Clock;
  log(line: string): void;
}): SessionInput {
  return createRawInput({
    client: deps.client,
    clock: deps.clock,
    id: deps.paneKey,
    log: deps.log,
    inputChannel: "terminal:input",
    resizeChannel: "terminal:resize",
    logPrefix: "terminal-input",
  });
}
