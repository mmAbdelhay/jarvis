import { describe, expect, it } from "vitest";
import { rowsFromArray, rowsToPlain, splitParams, stampQueryType } from "./api-screen";

describe("api-screen: params row round-trip (fix round 2)", () => {
  it("rowsFromArray reads a row's own type when present, and leaves it undefined otherwise", () => {
    expect(rowsFromArray([{ name: "id", value: "1", enabled: true, type: "path" }])).toEqual([
      { name: "id", value: "1", enabled: true, type: "path" },
    ]);
    expect(rowsFromArray([{ name: "q", value: "x", enabled: true }])).toEqual([
      { name: "q", value: "x", enabled: true },
    ]);
  });

  it("stampQueryType leaves an existing type untouched but fills in 'query' for a typeless row", () => {
    expect(
      stampQueryType([
        { name: "id", value: "1", enabled: true, type: "path" },
        { name: "q", value: "x", enabled: true },
      ]),
    ).toEqual([
      { name: "id", value: "1", enabled: true, type: "path" },
      { name: "q", value: "x", enabled: true, type: "query" },
    ]);
  });

  it('Tests (fix round 2): a brand-new query row (as KeyValueRows.addRow() creates it, with no type at all) round-trips through rowsToPlain carrying type: "query" — never silently dropped by the laptop\'s serializer, which only emits query/path rows', () => {
    const newRow = { name: "limit", value: "10", enabled: true }; // no `type` — exactly what addRow() produces
    const plain = rowsToPlain(stampQueryType([newRow]));
    expect(plain).toEqual([{ name: "limit", value: "10", enabled: true, type: "query" }]);
  });

  it('splitParams separates path rows (type: "path") from everything else (query rows, typed or not)', () => {
    const draft = {
      params: [
        { name: "id", value: "1", enabled: true, type: "path" },
        { name: "q", value: "x", enabled: true, type: "query" },
        { name: "new", value: "", enabled: true }, // untyped — still a query row
      ],
    };
    const { path, query } = splitParams(draft);
    expect(path).toEqual([{ name: "id", value: "1", enabled: true, type: "path" }]);
    expect(query).toEqual([
      { name: "q", value: "x", enabled: true, type: "query" },
      { name: "new", value: "", enabled: true },
    ]);
  });
});
