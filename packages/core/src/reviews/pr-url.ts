// Spots a GitHub pull request URL in a terminal pane's raw output, so a PR
// an agent opens in that pane can name the tab and link it in Reviews.
// The output is what a TUI writes, not text: colour codes split the URL,
// an agent may print it as an OSC 8 hyperlink whose visible text is
// something else, a narrow pane wraps it onto the next line (often behind
// a box border), and a chunk can end halfway through it. Each pane keeps a
// short raw tail so a URL cut by a chunk boundary is read whole next time.

export type PrRef = { repo: string; number: number };

export type PrUrlScanner = {
  /** Feeds one output chunk. Returns the last PR in it not already
   *  reported for this pane, or undefined. */
  push(paneKey: string, chunk: string): PrRef | undefined;
  /** Drops a pane's tail and what it reported (its shell exited). */
  forget(paneKey: string): void;
};

/** Raw output kept per pane: plenty for one URL plus the escapes around it. */
const TAIL_CHARS = 4096;
const PREFIX = "https://github.com/";
const PR_PATH = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)$/;
/** Characters that continue a URL. `#`, `?` and friends are included so a
 *  link into a comment or a query reads as that, not as the PR itself. */
const URL_CHAR = /[A-Za-z0-9._~/#?=&%+:-]/;
/** What may sit between the two halves of a wrapped URL: padding and a
 *  box-drawing border on either side of the line break. */
const WRAP_CHAR = /[ \t\r\n│┃|]/;

// OSC 8 (ESC ] 8 ; params ; URI BEL|ST): keep the target, spaced off so
// it reads as one word whatever surrounds it.
// biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences are what these patterns strip.
const OSC8 = /\x1b\]8;[^;\x07\x1b]*;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences are what these patterns strip.
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences are what these patterns strip.
const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences are what these patterns strip.
const ESC2 = /\x1b[@-Z\\-_]/g;

function plainText(raw: string): string {
  return raw
    .replace(OSC8, (_match, uri: string) => (uri === "" ? " " : ` ${uri} `))
    .replace(OSC, "")
    .replace(CSI, "")
    .replace(ESC2, "");
}

/** The URL starting at `from`, rejoined across a wrapped line break; or
 *  undefined when the text ends before the URL does. */
function readUrl(text: string, from: number): string | undefined {
  let url = "";
  let i = from;
  while (i < text.length) {
    const ch = text[i] as string;
    if (URL_CHAR.test(ch)) {
      url += ch;
      i += 1;
      continue;
    }
    // A wrap rejoins only before the number starts: past that point a line
    // break is as likely to end the URL as to split it.
    let j = i;
    while (j < text.length && WRAP_CHAR.test(text[j] as string)) j += 1;
    const hasBreak = text.slice(i, j).includes("\n");
    const inNumber = /\/pull\/\d/.test(url);
    if (hasBreak && !inNumber && j < text.length && URL_CHAR.test(text[j] as string)) {
      i = j;
      continue;
    }
    return url;
  }
  return undefined;
}

export function createPrUrlScanner(): PrUrlScanner {
  const tails = new Map<string, string>();
  const reported = new Map<string, Set<string>>();

  return {
    push(paneKey, chunk) {
      const raw = (tails.get(paneKey) ?? "") + chunk;
      tails.set(paneKey, raw.slice(-TAIL_CHARS));
      if (!raw.includes("pull")) return undefined;

      const text = plainText(raw);
      let seen = reported.get(paneKey);
      let found: PrRef | undefined;
      for (let at = text.indexOf(PREFIX); at !== -1; at = text.indexOf(PREFIX, at + 1)) {
        // Sentence punctuation after a URL is not part of it.
        const url = readUrl(text, at)?.replace(/[.,:;!?)]+$/, "");
        const match = url === undefined ? null : PR_PATH.exec(url);
        if (match === null) continue;
        const ref = { repo: `${match[1]}/${match[2]}`, number: Number(match[3]) };
        const key = `${ref.repo.toLowerCase()}#${ref.number}`;
        if (seen === undefined) {
          seen = new Set();
          reported.set(paneKey, seen);
        }
        if (seen.has(key)) continue;
        seen.add(key);
        found = ref;
      }
      return found;
    },

    forget(paneKey) {
      tails.delete(paneKey);
      reported.delete(paneKey);
    },
  };
}
