# Threat model

What Jarvis on Rafiq protects, who it protects it from, and where each
protection lives. Every mitigation links the code that does it and the test
that proves it. `packages/cli/src/docs/threat-model.test.ts` walks those links,
so CI fails if a linked test disappears or is renamed.

## Assets

| ID | Asset | Where it lives |
|---|---|---|
| S1 | Your files and settings | `$HOME` |
| S2 | Root on this machine | the root helper `os.jarvis.Helper1`; the installer backend `os.jarvis.Installer1` (live ISO only) |
| S3 | Secrets you type | Wi-Fi passwords on cards; account and disk passwords in the installer |
| S4 | Model provider keys | the Secret Service, one entry per provider id |
| S5 | The disk | partitions and the encrypted root the installer creates |

## Actors

| ID | Actor | How they reach Jarvis |
|---|---|---|
| A1 | Prompt injection | text Jarvis reads: logs, web pages, package descriptions, files, tool output |
| A2 | A malicious local process running as you | the control socket, your files, the Secret Service while it is unlocked |
| A3 | A malicious MCP tool server | the tools it declares and the text it returns |
| A4 | A compromised model provider | every model request and every reply |
| A5 | Someone at your unlocked session | the shell, the `jarvis` terminal client, Settings |
| A6 | Physical theft of the machine | the disk while the machine is off |

## What the confirm card is (and is not)

The confirm card is a UI gate, not a security boundary, against processes
running as you. Any program running under your user can read the control
secret in `~/.config/jarvis/run/` and answer a card itself, just as it could
type into your terminal. The card exists so that *Jarvis* never changes
anything you did not see and approve. Root-level actions are also checked by
polkit in the root helper, and that check is the boundary.

## Mitigations

| ID | Actors | Threat | Mitigation | Code | Tests |
|---|---|---|---|---|---|
| M1 | A1, A3 | Text from tools steers the model | Tool output reaches the model fenced as untrusted data; attempts to close the fence are neutralised | [fence.ts](https://github.com/mmAbdelhay/jarvis/blob/master/packages/core/src/agent/fence.ts) | [neutralises an attempt to close or reopen the fence, in any case](https://github.com/mmAbdelhay/jarvis/blob/master/packages/core/src/agent/fence.test.ts) |
| M2 | A1, A3, A4 | The model starts a change you did not want | Every confirm or password tool call waits for a card; Deny, no answer in 5 minutes, or nothing ticked runs nothing | [risk-gate.ts](https://github.com/mmAbdelhay/jarvis/blob/master/packages/core/src/agent/risk-gate.ts) | [runs nothing on Deny, and nothing when Approve comes with nothing ticked](https://github.com/mmAbdelhay/jarvis/blob/master/packages/core/src/agent/risk-gate.test.ts), [treats no answer in 5 minutes as Deny](https://github.com/mmAbdelhay/jarvis/blob/master/packages/core/src/agent/risk-gate.test.ts) |
| M3 | A3 | A tool server claims its tools are safe | Declared risk is trusted only from allowlisted servers; every other server's tools are confirm | [tool-registry.ts](https://github.com/mmAbdelhay/jarvis/blob/master/packages/core/src/agent/tool-registry.ts) | [makes an unknown server's tools confirm even when they claim safe](https://github.com/mmAbdelhay/jarvis/blob/master/packages/core/src/agent/tool-registry.test.ts), [trusts declared risk only from allowlisted servers](https://github.com/mmAbdelhay/jarvis/blob/master/packages/core/src/agent/tool-registry.test.ts) |
| M4 | A1, A4 | Secrets end up in model requests or the activity log | Secret fields are removed from the schema the model sees, filled only from the card, and logged as hidden | [tool-registry.ts](https://github.com/mmAbdelhay/jarvis/blob/master/packages/core/src/agent/tool-registry.ts), [audit.ts](https://github.com/mmAbdelhay/jarvis/blob/master/packages/core/src/agent/audit.ts) | [removes secret properties and requirements from the schema the model sees](https://github.com/mmAbdelhay/jarvis/blob/master/packages/core/src/agent/tool-registry.test.ts), [drops secret fields the model sent and marks provided secrets hidden](https://github.com/mmAbdelhay/jarvis/blob/master/packages/core/src/agent/audit.test.ts) |
| M5 | A4 | Log excerpts sent to the provider leak passwords and tokens | jarvis-diag redacts secrets before any text leaves the process | [redact.go](https://github.com/mmAbdelhay/jarvis/blob/master/os/go/internal/redact/redact.go) | [TestPatterns](https://github.com/mmAbdelhay/jarvis/blob/master/os/go/internal/redact/redact_test.go), [TestPartialLineIsRedactedNotDropped](https://github.com/mmAbdelhay/jarvis/blob/master/os/go/internal/redact/redact_test.go) |
| M6 | A1, A2 | A tool asks the root helper for something dangerous | The helper runs only fixed operations, validates every name, and asks polkit for each call | [service.go](https://github.com/mmAbdelhay/jarvis/blob/master/os/go/internal/helper/service.go), [auth.go](https://github.com/mmAbdelhay/jarvis/blob/master/os/go/internal/helper/auth.go) | [TestHostileNamesNeverReachARunnerOrPolkit](https://github.com/mmAbdelhay/jarvis/blob/master/os/go/internal/helper/service_test.go), [TestDeniedCallerRunsNothing](https://github.com/mmAbdelhay/jarvis/blob/master/os/go/internal/helper/service_test.go), [TestAuthorizeDenials](https://github.com/mmAbdelhay/jarvis/blob/master/os/go/internal/helper/auth_test.go) |
| M7 | A1 | A removal pulls out the system itself | Removals that would take a package Jarvis depends on are refused | [service.go](https://github.com/mmAbdelhay/jarvis/blob/master/os/go/internal/helper/service.go) | [TestAptRemoveRefusesToTakeProtectedPackages](https://github.com/mmAbdelhay/jarvis/blob/master/os/go/internal/helper/service_test.go) |
| M8 | A1 | Restarting arbitrary system services | Only allowlisted units restart through the helper | [actions.go](https://github.com/mmAbdelhay/jarvis/blob/master/os/go/internal/diagtools/actions.go) | [TestRestartOffAllowlistExplainsAndRunsNothing](https://github.com/mmAbdelhay/jarvis/blob/master/os/go/internal/diagtools/actions_test.go) |
| M9 | A2 | Another process poses as jarvisd, or replays a login | Mutual HMAC proofs over fresh nonces; the secret lives in a 0700 run directory and never crosses the socket | [handshake.ts](https://github.com/mmAbdelhay/jarvis/blob/master/packages/desktop/src/daemon/control/handshake.ts), [server.ts](https://github.com/mmAbdelhay/jarvis/blob/master/packages/desktop/src/daemon/control/server.ts) | [closes a wrong client proof without replying past the challenge](https://github.com/mmAbdelhay/jarvis/blob/master/packages/desktop/src/daemon/control/control.test.ts), [refuses a client proof replayed against a new server nonce](https://github.com/mmAbdelhay/jarvis/blob/master/packages/desktop/src/daemon/control/control.test.ts), [recognises the daemon by its proof, and nothing else](https://github.com/mmAbdelhay/jarvis/blob/master/packages/desktop/src/daemon/control/control.test.ts) |
| M10 | A1, A4 | A Wi-Fi password leaks through argv or tool output | The password goes to NetworkManager on stdin only and never appears in output | [actions.go](https://github.com/mmAbdelhay/jarvis/blob/master/os/go/internal/diagtools/actions.go) | [TestWifiConnectPassesPasswordOnStdinOnly](https://github.com/mmAbdelhay/jarvis/blob/master/os/go/internal/diagtools/actions_test.go), [TestWifiPasswordNeverAppearsInServerOutput](https://github.com/mmAbdelhay/jarvis/blob/master/os/go/internal/diagtools/actions_test.go) |
| M11 | A5 | A password typed for one item goes with another | The shell sends secrets only for ticked items | [CardModel.cpp](https://github.com/mmAbdelhay/jarvis/blob/master/os/shell/src/models/CardModel.cpp) | [secretsGoOnlyWithTickedItems](https://github.com/mmAbdelhay/jarvis/blob/master/os/shell/tests/unit/tst_cardmodel.cpp), [secretForUntickedItemIsIgnored](https://github.com/mmAbdelhay/jarvis/blob/master/os/shell/tests/unit/tst_cardmodel.cpp) |
| M12 | A1, A3 | Card text formatted to mislead | Card titles render as plain text in the shell; the terminal client strips every escape and control sequence | [ConfirmCard.qml](https://github.com/mmAbdelhay/jarvis/blob/master/os/shell/src/qml/ConfirmCard.qml), [sanitize.ts](https://github.com/mmAbdelhay/jarvis/blob/master/packages/cli/src/sanitize.ts) | [test_titlesRenderAsPlainText](https://github.com/mmAbdelhay/jarvis/blob/master/os/shell/tests/qml/tst_confirmcard.qml), [strips terminal control sequences from untrusted text](https://github.com/mmAbdelhay/jarvis/blob/master/packages/cli/src/sanitize.test.ts) |
| M13 | A1, A2 | A script pipes "a" into the terminal client to approve a change | The terminal client never answers a card, and never reads a secret, without an interactive terminal | [card.ts](https://github.com/mmAbdelhay/jarvis/blob/master/packages/cli/src/card.ts), [terminal.ts](https://github.com/mmAbdelhay/jarvis/blob/master/packages/cli/src/terminal.ts) | [never answers a card from piped input: denies without reading](https://github.com/mmAbdelhay/jarvis/blob/master/packages/cli/src/card.test.ts), [reads a secret without echoing it, with backspace, and leaves raw mode](https://github.com/mmAbdelhay/jarvis/blob/master/packages/cli/src/terminal.test.ts) |
| M14 | A2, A6 | Provider keys stored in a readable file | Keys go to the Secret Service, never to `jarvis.yaml` | [agent-service.ts](https://github.com/mmAbdelhay/jarvis/blob/master/packages/desktop/src/daemon/os/agent-service.ts) | [lists no provider, saves one after a good probe (key to the keyring, not the file), lists it](https://github.com/mmAbdelhay/jarvis/blob/master/packages/desktop/src/daemon/os/agent-service.test.ts) |
| M15 | A6 | Installer passwords end up in argv or the install log | Secrets reach child processes on stdin only; the install log is redacted | [execute.go](https://github.com/mmAbdelhay/jarvis/blob/master/os/go/internal/install/execute.go), [log.go](https://github.com/mmAbdelhay/jarvis/blob/master/os/go/internal/install/log.go) | [TestExecuteNeverPutsASecretInArgv](https://github.com/mmAbdelhay/jarvis/blob/master/os/go/internal/install/execute_test.go), [TestLoggerRedactsSecretsAndTokens](https://github.com/mmAbdelhay/jarvis/blob/master/os/go/internal/install/render_test.go) |
| M16 | A6 | A stolen disk is readable | The installer sets up LUKS full-disk encryption when you choose it | [execute.go](https://github.com/mmAbdelhay/jarvis/blob/master/os/go/internal/install/execute.go) | [TestExecuteEraseEncryptLocalModel](https://github.com/mmAbdelhay/jarvis/blob/master/os/go/internal/install/execute_test.go) |

## Accepted risks

| ID | Actors | Risk | Why we accept it |
|---|---|---|---|
| R1 | A2 | A process running as you can read the control secret, answer cards, or edit `jarvis.yaml` | Isolating programs of the same user is the operating system's job; the card is a UI gate (above). Root actions still need polkit. |
| R2 | A5 | Someone at your unlocked session can ask Jarvis for anything you could approve | Lock your screen when you leave. Every change still shows a card and lands in the activity log. |
| R3 | A4 | The provider sees what you send it: your messages, redacted log excerpts, tool results | Choose a model on this computer to keep everything local. |
| R4 | A6 | An install without encryption can be read from the disk | Encryption is one tick on the installer's Disk screen. |
