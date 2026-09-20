// The one place the bridge's idle timer is allowed to reach the disk. It is
// invoked only from the bridge's own `onIdleDisabled` callback — never from
// a phone's request, and never through `settings:save` — and it never
// throws: a failed read or write is logged and answered with `false`, so a
// disconnected filesystem or a torn config file leaves the bridge off (the
// listener is already closed by the time this runs) without ever crashing
// the app or reopening the port.
import type { JarvisConfig } from "./config.js";
import type { SettingsWriteResult } from "./settings-io.js";

export type DisableRemoteOnDiskDeps = {
  /**
   * Reads the current config and writes `update(current)` back, as one
   * atomic step inside the same serialized write queue Settings' own saves
   * go through (main.ts's `writeConfig`) — never a bare `readConfig()`
   * followed by a *separately* queued `writeConfig(draft)`, which a
   * same-tick Settings save could land between: that save would queue
   * ahead of this write and then be silently undone by a draft built from
   * what was on disk before it (M12 Task 2 minor). Returning `current`
   * itself from `update` — this file's own "already off" case — is a
   * no-op: main.ts's `writeConfig` skips the disk write (and the bridge
   * re-apply that follows a real one) whenever `update` hands back the
   * exact object it was given.
   */
  writeConfig(update: (current: JarvisConfig) => JarvisConfig): Promise<SettingsWriteResult>;
  log(line: string): void;
};

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Flips `remote.enabled` to false and writes the result back — every other
 * key, including a hand-written `remote:` section, rides along unchanged,
 * because the draft `update` builds is always a spread of the `current`
 * config `deps.writeConfig` itself reads, never a fresh default.
 *
 * If `current.remote.enabled` is already false — someone beat the timer to
 * it, or the bridge was never enabled there in the first place — `update`
 * returns `current` unchanged, so nothing is written, and this still
 * resolves true after logging that nothing changed.
 */
export async function disableRemoteOnDisk(deps: DisableRemoteOnDiskDeps): Promise<boolean> {
  let wasEnabled = true;
  try {
    const result = await deps.writeConfig((current) => {
      wasEnabled = current.remote.enabled;
      if (!wasEnabled) return current;
      return { ...current, remote: { ...current.remote, enabled: false } };
    });

    if (!wasEnabled) {
      deps.log("remote: idle auto-disable — already off on disk");
      return true;
    }
    if (result.ok) {
      deps.log("remote: idle auto-disable saved to jarvis.yaml");
      return true;
    }
    deps.log(`remote: idle auto-disable could not save: ${result.detail}`);
    return false;
  } catch (error) {
    deps.log(`remote: idle auto-disable could not save: ${errorDetail(error)}`);
    return false;
  }
}
