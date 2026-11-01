import { type PrKey, type PullRequest, prKey } from "./types.js";

export type PaneFacts = {
  paneKey: string;
  repo?: string;
  branch?: string;
  exited: boolean;
};

export type LinkResult =
  | { kind: "linked"; paneKey: string; how: "manual" | "auto" }
  | { kind: "none" }
  | { kind: "ambiguous"; paneKeys: string[] };

export function resolveLink(
  pr: PullRequest,
  panes: PaneFacts[],
  manual: ReadonlyMap<PrKey, string | null>,
  autoLink: boolean,
): LinkResult {
  const key = prKey(pr.repo, pr.number);
  const manualKey = manual.get(key);
  if (manual.has(key) && manualKey === null) return { kind: "none" };
  if (
    typeof manualKey === "string" &&
    panes.some((pane) => pane.paneKey === manualKey && !pane.exited)
  ) {
    return { kind: "linked", paneKey: manualKey, how: "manual" };
  }
  if (!autoLink) return { kind: "none" };

  const matches = panes.filter(
    (pane) =>
      !pane.exited &&
      pane.repo?.toLowerCase() === pr.repo.toLowerCase() &&
      pane.branch === pr.headRef,
  );
  const match = matches[0];
  if (matches.length > 1) {
    return { kind: "ambiguous", paneKeys: matches.map((pane) => pane.paneKey) };
  }
  if (match) return { kind: "linked", paneKey: match.paneKey, how: "auto" };
  return { kind: "none" };
}
