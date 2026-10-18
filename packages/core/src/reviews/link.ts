import { type PrKey, type PullRequest, prKey } from "./types.js";

export type PaneFacts = {
  paneKey: string;
  repo?: string;
  branch?: string;
  exited: boolean;
};

export function resolveLink(
  pr: PullRequest,
  panes: PaneFacts[],
  manual: ReadonlyMap<PrKey, string>,
  autoLink: boolean,
):
  | { kind: "linked"; paneKey: string; how: "manual" | "auto" }
  | { kind: "none" }
  | { kind: "ambiguous"; paneKeys: string[] } {
  const manualKey = manual.get(prKey(pr.repo, pr.number));
  if (manualKey !== undefined && panes.some((pane) => pane.paneKey === manualKey && !pane.exited)) {
    return { kind: "linked", paneKey: manualKey, how: "manual" };
  }
  if (!autoLink) return { kind: "none" };

  const matches = panes.filter(
    (pane) => !pane.exited && pane.repo === pr.repo && pane.branch === pr.headRef,
  );
  const match = matches[0];
  if (matches.length > 1) {
    return { kind: "ambiguous", paneKeys: matches.map((pane) => pane.paneKey) };
  }
  if (match) return { kind: "linked", paneKey: match.paneKey, how: "auto" };
  return { kind: "none" };
}
