// The light markdown an agent's reply is drawn with in the Chat view, and how
// a link is labelled. A port of the phone's chat-text.ts and linkParts
// (apps/mobile/src/lib), kept rule for rule: the renderer cannot import from
// the mobile app, and the two views must read a reply the same way. Pure
// data — nothing here touches the DOM; agent-chat.ts draws it with
// textContent only.
export type ChatInline =
  | { kind: "text"; text: string }
  | { kind: "bold"; text: string }
  | { kind: "code"; text: string }
  | { kind: "link"; text: string; url: string };

export type ChatBlock =
  | { kind: "para"; inlines: ChatInline[] }
  | { kind: "list"; ordered: boolean; items: { marker: string; inlines: ChatInline[] }[] }
  | { kind: "codeBlock"; text: string };

function parseInlines(text: string): ChatInline[] {
  const inlines: ChatInline[] = [];
  const pattern =
    /(?<!`)`([^`\n]+)`(?!`)|\*\*([^\n]+?)\*\*|\[([^\]\n]*)\]\((https:\/\/[^\s)]+)\)|https:\/\/[^\s]+/g;
  let cursor = 0;
  const appendText = (value: string) => {
    if (!value) return;
    const last = inlines[inlines.length - 1];
    if (last?.kind === "text") last.text += value;
    else inlines.push({ kind: "text", text: value });
  };
  for (const match of text.matchAll(pattern)) {
    appendText(text.slice(cursor, match.index));
    if (match[1] !== undefined) inlines.push({ kind: "code", text: match[1] });
    else if (match[2] !== undefined) inlines.push({ kind: "bold", text: match[2] });
    else if (match[3] !== undefined && match[4] !== undefined) {
      inlines.push({ kind: "link", text: match[3], url: match[4] });
    } else {
      const url = match[0].replace(/[).,;:!?]+$/, "");
      inlines.push({ kind: "link", text: url, url });
      appendText(match[0].slice(url.length));
    }
    cursor = match.index + match[0].length;
  }
  appendText(text.slice(cursor));
  return inlines;
}

export function parseChatText(text: string): ChatBlock[] {
  const blocks: ChatBlock[] = [];
  const lines = text.split("\n");
  const listPattern = /^(-|\*|\d+\.) (.*)$/;
  let paragraph: string[] = [];
  const flushParagraph = () => {
    if (paragraph.length) {
      blocks.push({ kind: "para", inlines: parseInlines(paragraph.join("\n")) });
      paragraph = [];
    }
  };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (/^```[^`]*$/.test(line)) {
      flushParagraph();
      const inner: string[] = [];
      index++;
      while (index < lines.length && !/^```\s*$/.test(lines[index] ?? "")) {
        inner.push(lines[index] ?? "");
        index++;
      }
      blocks.push({ kind: "codeBlock", text: inner.join("\n") });
    } else if (/^\s*$/.test(line)) {
      flushParagraph();
    } else {
      const item = listPattern.exec(line);
      if (item) {
        flushParagraph();
        const ordered = item[1] !== "-" && item[1] !== "*";
        const last = blocks[blocks.length - 1];
        const entry = {
          marker: ordered ? (item[1] ?? "") : "•",
          inlines: parseInlines(item[2] ?? ""),
        };
        if (
          last?.kind === "list" &&
          last.ordered === ordered &&
          index > 0 &&
          listPattern.test(lines[index - 1] ?? "")
        ) {
          last.items.push(entry);
        } else blocks.push({ kind: "list", ordered, items: [entry] });
      } else paragraph.push(line);
    }
  }
  flushParagraph();
  return blocks;
}

/** A link's visible text, and the host beside it whenever the text does
 *  not plainly start with that host: a label, a `user:pass@` prefix or a
 *  look-alike cannot hide where the link goes. */
export function linkParts(text: string, url: string): { text: string; host?: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { text: url };
  }
  const host = parsed.host.toLowerCase();
  const bare = url.replace(/^https:\/\//i, "").replace(/\/$/, "");
  const shown = text === url || text === bare || text.toLowerCase() === host ? bare : text;
  const leading = shown
    .replace(/^https:\/\//i, "")
    .split(/[/?#]/, 1)[0]
    ?.toLowerCase();
  const credentials = parsed.username !== "" || parsed.password !== "";
  if (!credentials && leading === host) return { text: shown };
  return { text: shown, host };
}

/** Whether a URL may be opened from a reply: https only. */
export function isHttpsUrl(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}
