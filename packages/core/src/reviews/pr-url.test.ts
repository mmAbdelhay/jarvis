import { describe, expect, it } from "vitest";
import { createPrUrlScanner } from "./pr-url.js";

const URL_42 = "https://github.com/acme/widgets/pull/42";

describe("createPrUrlScanner", () => {
  it("finds a plain PR URL", () => {
    const scan = createPrUrlScanner();
    expect(scan.push("p", `Created ${URL_42}\r\n`)).toEqual({ repo: "acme/widgets", number: 42 });
  });

  it("finds a URL split across two chunks", () => {
    const scan = createPrUrlScanner();
    expect(scan.push("p", "PR: https://github.com/acme/wid")).toBeUndefined();
    expect(scan.push("p", "gets/pull/42\r\n")).toEqual({ repo: "acme/widgets", number: 42 });
  });

  it("finds a URL coloured with SGR codes and split by them", () => {
    const scan = createPrUrlScanner();
    const coloured = "\x1b[36mhttps://github.com/\x1b[1macme/widgets\x1b[0m/pull/\x1b[4m42\x1b[0m ";
    expect(scan.push("p", coloured)).toEqual({ repo: "acme/widgets", number: 42 });
  });

  it("reads an OSC 8 hyperlink's target, whatever its visible text", () => {
    const scan = createPrUrlScanner();
    expect(scan.push("p", `\x1b]8;;${URL_42}\x07PR #42\x1b]8;;\x07\r\n`)).toEqual({
      repo: "acme/widgets",
      number: 42,
    });
    const st = createPrUrlScanner();
    expect(st.push("p", `\x1b]8;;${URL_42}\x1b\\link\x1b]8;;\x1b\\`)).toEqual({
      repo: "acme/widgets",
      number: 42,
    });
  });

  it("rejoins a URL the TUI wrapped onto the next line", () => {
    const scan = createPrUrlScanner();
    const wrapped = "│ https://github.com/acme/wid\r\n│   gets/pull/42 │\r\n";
    expect(scan.push("p", wrapped)).toEqual({ repo: "acme/widgets", number: 42 });
  });

  it("drops sentence punctuation after the URL", () => {
    const scan = createPrUrlScanner();
    expect(scan.push("p", `Opened ${URL_42}.\nNext line`)).toEqual({
      repo: "acme/widgets",
      number: 42,
    });
  });

  it("reports one PR once per pane", () => {
    const scan = createPrUrlScanner();
    expect(scan.push("p", `${URL_42}\n`)).toBeDefined();
    expect(scan.push("p", `again ${URL_42}\n`)).toBeUndefined();
    expect(scan.push("q", `${URL_42}\n`)).toBeDefined();
  });

  it("reports a newer PR in the same pane, the last one in a chunk winning", () => {
    const scan = createPrUrlScanner();
    scan.push("p", `${URL_42}\n`);
    expect(
      scan.push(
        "p",
        "https://github.com/acme/widgets/pull/43 https://github.com/acme/gizmo/pull/7 ",
      ),
    ).toEqual({ repo: "acme/gizmo", number: 7 });
  });

  it("ignores links into a PR's tabs and non-GitHub URLs", () => {
    const scan = createPrUrlScanner();
    expect(scan.push("p", `${URL_42}/files ${URL_42}/commits\n`)).toBeUndefined();
    expect(scan.push("p", "https://gitlab.com/acme/widgets/pull/42\n")).toBeUndefined();
    expect(scan.push("p", "https://github.com/acme/widgets/issues/42\n")).toBeUndefined();
  });

  it("does not read a number cut short at the chunk's end", () => {
    const scan = createPrUrlScanner();
    expect(scan.push("p", "https://github.com/acme/widgets/pull/4")).toBeUndefined();
    expect(scan.push("p", "2\r\n")).toEqual({ repo: "acme/widgets", number: 42 });
  });

  it("forgets a pane, so a restarted shell under the same key reports again", () => {
    const scan = createPrUrlScanner();
    scan.push("p", `${URL_42}\n`);
    scan.forget("p");
    expect(scan.push("p", `${URL_42}\n`)).toBeDefined();
  });
});
