// Core keeps its own copy of the contract types (it may import no workspace
// package); this file fails `pnpm typecheck` the moment the copies differ.
import type * as Core from "@jarvis/core";
import type * as Wire from "@jarvis/wire";
import { describe, expectTypeOf, it } from "vitest";

describe("core's agent types are exactly the contract's (@jarvis/wire)", () => {
  it("matches every §3.3 type", () => {
    expectTypeOf<Core.AuditVia>().toEqualTypeOf<Wire.AuditVia>();
    expectTypeOf<Core.VoiceAvailability>().toEqualTypeOf<Wire.VoiceAvailability>();
    expectTypeOf<Core.VoiceLang>().toEqualTypeOf<Wire.VoiceLang>();
    expectTypeOf<Core.VoiceAction>().toEqualTypeOf<Wire.VoiceAction>();
    expectTypeOf<Core.UndoResult>().toEqualTypeOf<Wire.UndoResult>();

    expectTypeOf<Core.AgentEvent>().toEqualTypeOf<Wire.AgentEvent>();
    expectTypeOf<Core.Card>().toEqualTypeOf<Wire.Card>();
    expectTypeOf<Core.CardItem>().toEqualTypeOf<Wire.CardItem>();
    expectTypeOf<Core.DoctorState>().toEqualTypeOf<Wire.DoctorState>();
    expectTypeOf<Core.DoctorStep>().toEqualTypeOf<Wire.DoctorStep>();
    expectTypeOf<Core.AuditEntry>().toEqualTypeOf<Wire.AuditEntry>();
    expectTypeOf<Core.ProbeResult>().toEqualTypeOf<Wire.ProbeResult>();
    expectTypeOf<Core.ProviderConfig>().toEqualTypeOf<Wire.ProviderConfig>();
    expectTypeOf<Core.ProviderDraft>().toEqualTypeOf<Wire.ProviderDraft>();
    expectTypeOf<Core.ConfirmAnswer>().toEqualTypeOf<Wire.ConfirmAnswer>();
    expectTypeOf<Core.AuditQuery>().toEqualTypeOf<Wire.AuditQuery>();
    expectTypeOf<Core.ProviderReachability>().toEqualTypeOf<Wire.ProviderStatusPush>();
    expectTypeOf<Core.UpdatesSummary>().toEqualTypeOf<Wire.UpdatesSummary>();
    expectTypeOf<Core.ModelDownload>().toEqualTypeOf<Wire.ModelDownload>();
    expectTypeOf<Core.UpdatesCheckResult>().toEqualTypeOf<Wire.UpdatesCheckResult>();
    expectTypeOf<Core.SysSnapshot>().toEqualTypeOf<Wire.SysSnapshot>();
    expectTypeOf<Core.ProviderListEntry>().toEqualTypeOf<Wire.ProviderListEntry>();
    expectTypeOf<Core.ProviderDraftEntry>().toEqualTypeOf<Wire.ProviderDraftEntry>();
    expectTypeOf<Core.ProviderListResult>().toEqualTypeOf<Wire.ProviderListResult>();
    expectTypeOf<Core.ProviderSaveRequest>().toEqualTypeOf<Wire.ProviderSaveRequest>();
    expectTypeOf<Core.ProviderSaveResult>().toEqualTypeOf<Wire.ProviderSaveResult>();
    expectTypeOf<Core.MemoryItem>().toEqualTypeOf<Wire.MemoryItem>();
    expectTypeOf<Core.RegistryEntry>().toEqualTypeOf<Wire.RegistryEntry>();
    expectTypeOf<Core.RegistryListResult>().toEqualTypeOf<Wire.RegistryListResult>();
    expectTypeOf<Core.UiLanguage>().toEqualTypeOf<Wire.UiLanguage>();
  });
});
