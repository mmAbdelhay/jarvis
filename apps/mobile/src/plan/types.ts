export type PlanBlock = {
  id: string;
  kind: string;
  level?: number;
  start: number;
  end: number;
  source: string;
  html: string;
};

export type PlanEntry = {
  path: string;
  name: string;
  source: "session" | "planMode" | "repo";
  repoKind?: string;
  project?: string;
  mtimeMs: number;
};

export type PlanList = { session?: PlanEntry; planMode: PlanEntry[]; repo: PlanEntry[] };
export type PlanDoc = { path: string; mtimeMs: number; blocks: PlanBlock[] };
export type PlanResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string; detail?: string; doc?: PlanDoc };

export type PlanComment = {
  id: string;
  path: string;
  blockId: string;
  quote: string;
  body: string;
  createdAt: number;
  sentAt?: number;
};

export type AnchoredComment = PlanComment & {
  number: number;
  anchor: { kind: "block"; blockId: string } | { kind: "orphaned" };
};
