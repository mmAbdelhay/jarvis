import { describe, expect, it } from "vitest";
import { createBlobRegistry, dataUrlToBase64 } from "./web-blob-registry";

function setup() {
  const revoked: string[] = [];
  let next = 0;
  const registry = createBlobRegistry<{ size: number }>({
    create: () => {
      next += 1;
      return `blob:app/${next}`;
    },
    revoke: (url) => revoked.push(url),
  });
  return { registry, revoked };
}

describe("createBlobRegistry", () => {
  it("hands out a url per blob and answers its blob and size", () => {
    const { registry } = setup();
    const blob = { size: 1234 };
    const uri = registry.add(blob);
    expect(uri).toBe("blob:app/1");
    expect(registry.get(uri)).toBe(blob);
    expect(registry.size(uri)).toBe(1234);
  });

  it("answers undefined for a uri it never handed out (a file:// uri, a forged blob: url)", () => {
    const { registry } = setup();
    expect(registry.get("file:///rec.m4a")).toBeUndefined();
    expect(registry.size("blob:app/99")).toBeUndefined();
  });

  it("remove revokes the url and forgets the blob; a second remove is a silent no-op", () => {
    const { registry, revoked } = setup();
    const uri = registry.add({ size: 1 });
    registry.remove(uri);
    expect(revoked).toEqual([uri]);
    expect(registry.get(uri)).toBeUndefined();
    registry.remove(uri);
    registry.remove("blob:app/unknown");
    expect(revoked).toEqual([uri]);
  });
});

describe("dataUrlToBase64", () => {
  it("strips the data: prefix up to and including the first comma", () => {
    expect(dataUrlToBase64("data:audio/webm;codecs=opus;base64,AAEC")).toBe("AAEC");
  });

  it("answers undefined for anything not a base64 data url", () => {
    expect(dataUrlToBase64("AAEC")).toBeUndefined();
    expect(dataUrlToBase64("data:text/plain,hello")).toBeUndefined();
  });
});
