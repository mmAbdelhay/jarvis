import { describe, expect, it } from "vitest";
import {
  changesLeftWidth,
  changesOneColumn,
  contentWidth,
  historyListWidth,
  homeSideBySide,
  homeTileColumns,
  sessionsListWidth,
  settingsSideBySide,
  workspaceShowsFilesAside,
  workspaceShowsPlanDock,
} from "./wide-breakpoints";

describe("wide breakpoints", () => {
  it("subtracts the sidebar or the rail", () => {
    expect(contentWidth(1440, "full")).toBe(1200);
    expect(contentWidth(1440, "rail")).toBe(1376);
    expect(contentWidth(820, "rail")).toBe(756);
  });

  it("switches at the documented widths", () => {
    expect([homeTileColumns(999), homeTileColumns(1000)]).toEqual([2, 4]);
    expect([homeSideBySide(779), homeSideBySide(780)]).toEqual([false, true]);
    expect([sessionsListWidth(1099), sessionsListWidth(1100)]).toEqual([340, 400]);
    expect([historyListWidth(1099), historyListWidth(1100)]).toEqual([380, 460]);
    expect([changesLeftWidth(1099), changesLeftWidth(1100)]).toEqual([360, 400]);
    expect([changesOneColumn(899), changesOneColumn(900)]).toEqual([true, false]);
    expect([workspaceShowsFilesAside(899), workspaceShowsFilesAside(900)]).toEqual([false, true]);
    expect([workspaceShowsPlanDock(1099), workspaceShowsPlanDock(1100)]).toEqual([false, true]);
    expect([settingsSideBySide(819), settingsSideBySide(820)]).toEqual([false, true]);
  });
});
