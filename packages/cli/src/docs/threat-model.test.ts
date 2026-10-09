import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkThreatModel, parseThreatModel, section } from "./threat-model-links.js";

const REPO = fileURLToPath(new URL("../../../../", import.meta.url));
const DOC = readFileSync(join(REPO, "docs/os/threat-model.md"), "utf8");
const readRepoFile = (path: string) => {
  try {
    return readFileSync(join(REPO, path), "utf8");
  } catch {
    return undefined;
  }
};

describe("docs/os/threat-model.md (design §3.2, criterion 2)", () => {
  it("links every mitigation to code and tests that exist", () => {
    expect(checkThreatModel(parseThreatModel(DOC), readRepoFile)).toEqual([]);
  });

  it("names the design's five assets and six actors", () => {
    const model = parseThreatModel(DOC);
    expect(model.assets).toEqual(["S1", "S2", "S3", "S4", "S5"]);
    expect(model.actors).toEqual(["A1", "A2", "A3", "A4", "A5", "A6"]);
    expect(model.mitigations.length).toBeGreaterThanOrEqual(16);
  });

  it("states plainly that the confirm card is a UI gate, not a security boundary", () => {
    expect(DOC).toContain("The confirm card is a UI gate, not a security boundary");
  });

  it("covers the M2.5 mitigations (design §3.1, §3.3, §3.5, §3.7, §3.9)", () => {
    const mitigations = section(DOC, "Mitigations");
    for (const term of [
      "SAFETY_RULES",
      "os.jarvis.Installer1",
      "index.json.sig",
      "sha256",
      "community",
      "PrivateNetwork",
      "allowCloudFallback",
      "memory.sqlite",
    ]) {
      expect(mitigations, term).toContain(term);
    }
    expect(parseThreatModel(DOC).mitigations.length).toBeGreaterThanOrEqual(24);
  });

  it("covers the Rafiq M3 surfaces (criterion 8)", () => {
    const mitigations = section(DOC, "Mitigations");
    for (const term of [
      "$HOME",
      "files.trash",
      "undo",
      "settings.",
      "apps.open_path",
      "apps.open_url",
      "adminPassword",
      "unix_chkpwd",
      "voice:utterance",
      "phone:<deviceName>",
      "sys:setLocked",
      "locked",
      "51-jarvis-settings.rules",
      "50-jarvis.rules",
    ]) {
      expect(mitigations, term).toContain(term);
    }
    const accepted = section(DOC, "Accepted risks");
    for (const term of ["Super+L", "pam_faillock"]) expect(accepted, term).toContain(term);
    expect(parseThreatModel(DOC).mitigations.length).toBeGreaterThanOrEqual(35);
  });

  it("covers computer use (Rafiq v1.1 contracts section 4.11, design section 5)", () => {
    const mitigations = section(DOC, "Mitigations");
    for (const term of [
      "jarvis-cu",
      "screenshot",
      "fullscreen",
      "password",
      "describeFocused",
      "Super+Esc",
      "cu.sock",
      "consent",
    ]) {
      expect(mitigations, term).toContain(term);
    }
    const accepted = section(DOC, "Accepted risks");
    for (const term of [
      "fail open",
      "GTK4",
      "NODE_OPTIONS",
      "LD_PRELOAD",
      "Take over",
      "focus event",
      "150 ms",
      "200 characters",
      "label",
      "prompt injection",
    ]) {
      expect(accepted, term).toContain(term);
    }
    expect(parseThreatModel(DOC).mitigations.length).toBeGreaterThanOrEqual(44);
  });
});
