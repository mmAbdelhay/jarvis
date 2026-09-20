// task-5-brief.md, "Tests: app-lifecycle.test.ts — the five-row table."
import type { AppStateStatus } from "react-native";
import { describe, expect, it } from "vitest";
import { appActivityFor } from "./app-lifecycle";

describe("appActivityFor", () => {
  const table: [AppStateStatus, "activate" | "suspend" | "none"][] = [
    ["active", "activate"],
    ["background", "suspend"],
    ["inactive", "none"],
    ["unknown", "none"],
    ["extension", "none"],
  ];

  it.each(table)("%s -> %s", (status, expected) => {
    expect(appActivityFor(status)).toBe(expected);
  });
});
