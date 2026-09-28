import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createBrowserDialogs, dialogText } from "./dialog-core";

describe("dialogText", () => {
  it("joins title and message with a blank line, or is the title alone", () => {
    expect(dialogText("Log out", "You'll need your password.")).toBe(
      "Log out\n\nYou'll need your password.",
    );
    expect(dialogText("Delete “x”?", undefined)).toBe("Delete “x”?");
    expect(dialogText("Clear", "")).toBe("Clear");
  });
});

describe("createBrowserDialogs", () => {
  function setup(answer: boolean) {
    const asked: string[] = [];
    const shown: string[] = [];
    const dialogs = createBrowserDialogs({
      confirm: (text) => {
        asked.push(text);
        return answer;
      },
      alert: (text) => {
        shown.push(text);
      },
    });
    return { dialogs, asked, shown };
  }

  it("runs onConfirm only when the owner accepts", () => {
    const yes = setup(true);
    let ran = 0;
    yes.dialogs.confirm({ title: "Unpair", message: "Sure?", onConfirm: () => (ran += 1) });
    expect(yes.asked).toEqual(["Unpair\n\nSure?"]);
    expect(ran).toBe(1);

    const no = setup(false);
    no.dialogs.confirm({ title: "Unpair", onConfirm: () => (ran += 1) });
    expect(ran).toBe(1);
  });

  it("a notice shows its text and needs no answer", () => {
    const { dialogs, shown } = setup(true);
    dialogs.notice("Upload failed", undefined);
    expect(shown).toEqual(["Upload failed"]);
  });

  it("a browser that blocks dialogs (throws) counts as a refusal", () => {
    let ran = false;
    const dialogs = createBrowserDialogs({
      confirm: () => {
        throw new Error("blocked");
      },
      alert: () => {
        throw new Error("blocked");
      },
    });
    dialogs.confirm({ title: "x", onConfirm: () => (ran = true) });
    expect(ran).toBe(false);
    expect(() => dialogs.notice("x")).not.toThrow();
  });
});

describe("no direct Alert.alert (dead in the browser build)", () => {
  it("app/ and src/ reach dialogs only through lib/dialog", () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) && entry !== "dialog.ts") {
          if (/\bAlert\.alert\(/.test(readFileSync(full, "utf8"))) offenders.push(full);
        }
      }
    };
    walk(join(root, "app"));
    walk(join(root, "src"));
    expect(offenders).toEqual([]);
  });
});
