export type TabId = string;

/** One browser tab. `project` is fixed at open time: it decides the
 *  session partition, so moving a tab between projects would mean moving it
 *  between cookie jars — a different tab, not the same one relabelled. */
export type WorkspaceTab = {
  id: TabId;
  project: string;
  url: string;
  /** The page's own title, or "" until it reports one. */
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /** Set by a failed load, cleared by the next successful navigation. */
  error: string | undefined;
};

export type WorkspaceState = {
  tabs: WorkspaceTab[];
  activeTabId: TabId | undefined;
};

export type TabPatch = Partial<Omit<WorkspaceTab, "id" | "project">>;

/** One markdown file under a project root; `path` is relative to that root
 *  and is the only path the renderer ever handles. */
export type DocEntry = { path: string; name: string };

/** One piece of formatted text inside a block. */
export type DocInline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "emphasis"; children: DocInline[] }
  | { kind: "strong"; children: DocInline[] }
  | { kind: "link"; href: string; children: DocInline[] };

/**
 * One block of a rendered document. This is the shape markdown crosses IPC
 * in: data the renderer paints with createElement and textContent, never an
 * HTML string it would have to assign to innerHTML.
 */
export type DocBlock =
  | { kind: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; children: DocInline[] }
  | { kind: "paragraph"; children: DocInline[] }
  | { kind: "code"; language: string; text: string }
  | { kind: "rule" }
  | {
      kind: "list";
      ordered: boolean;
      items: DocBlock[][];
      /** GFM task-list state, aligned by index with `items`. `checked[i]`
       *  is `undefined` for an ordinary item and `true`/`false` for a
       *  `- [x]`/`- [ ]` one. Omitted entirely (not even as an all-undefined
       *  array) unless the list contains at least one task item, so a plain
       *  list's `toEqual` fixtures written before task lists existed still
       *  match exactly. */
      checked?: (boolean | undefined)[];
    }
  | { kind: "quote"; children: DocBlock[] }
  | { kind: "table"; head: DocInline[][]; rows: DocInline[][][] };
