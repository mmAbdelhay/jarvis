import { copyFile, readFile, writeFile } from "node:fs/promises";
import { stringify } from "yaml";
import type { JarvisConfig } from "./config.js";
import {
  DEFAULT_BROWSER,
  DEFAULT_PERFORMANCE,
  DEFAULT_SESSIONS,
  DEFAULT_TERMINAL,
  parseConfig,
} from "./config.js";

export type SettingsWriteResult = { ok: true } | { ok: false; detail: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The only validation Settings ever does. parseConfig reads the *file's*
 * shape (agents/routing/projects/brain/whisper as top-level siblings), not
 * JarvisConfig's own shape (agents/routing nested under `registry`, plus a
 * computed sessionsDbPath) — so a draft built from a prior settings:read()
 * has to go through toRawConfig first, the same transform writeSettingsFile
 * uses just before stringifying. This function does not assume `draft` is
 * really JarvisConfig-shaped at all: a malformed draft can throw inside
 * toRawConfig itself (e.g. no `registry` property to read), and that is
 * caught here exactly like a parseConfig rejection — validateDraft's own
 * contract is that it never throws, regardless of what it is handed.
 */
export function validateDraft(
  draft: unknown,
): { ok: true; value: JarvisConfig } | { ok: false; detail: string } {
  try {
    const raw = toRawConfig(draft as JarvisConfig);
    return { ok: true, value: parseConfig(raw) };
  } catch (error) {
    return { ok: false, detail: errorMessage(error) };
  }
}

/**
 * JarvisConfig's shape is not jarvis.yaml's shape: the file has agents,
 * routing, projects, brain, whisper as top-level siblings, while
 * JarvisConfig nests agents/routing under `registry` and adds a computed
 * sessionsDbPath the file has no key for at all. This is the one place
 * that difference is bridged, in both directions being made explicit here
 * rather than left implicit in a raw YAML.stringify(draft) call, which
 * would write a `registry:` key and a `sessionsDbPath:` key the file
 * format has never had.
 *
 * brain.configDir is deliberately left out: it is computed by parseConfig
 * from brain.accountId at load time (by looking up that agent's own
 * configDir), never itself a source of truth. Writing it back would be
 * redundant at best and stale at worst, the moment an agent's configDir
 * changes without brain.accountId also being re-saved.
 */
/**
 * Whether a whole-config section says anything its defaults do not.
 *
 * Structural rather than field-by-field: a section that grows a field would
 * otherwise keep comparing equal on the fields this function happened to
 * know about, and stop being written the moment the user set only the new
 * one. Both sides come from parseConfig or from a draft parseConfig
 * validated, so both are plain data with no ordering to worry about — but
 * the keys are sorted anyway, because "same JSON" must not depend on which
 * order two objects were built in.
 *
 * `undefined` counts as default: validateDraft hands toRawConfig
 * renderer-supplied data cast to JarvisConfig, and an older renderer may
 * never have filled a section in.
 */
function isDefault<T>(section: T | undefined, defaults: T): boolean {
  if (section === undefined) return true;
  return stableJson(section) === stableJson(defaults);
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) => {
    if (inner === null || typeof inner !== "object" || Array.isArray(inner)) return inner;
    return Object.fromEntries(
      Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
    );
  });
}

export function toRawConfig(config: JarvisConfig): unknown {
  return {
    agents: config.registry.agents,
    routing: config.registry.routing ?? [],
    projects: config.projects,
    // Written only when there is something to write: an empty `databases:
    // {}` key in a file that never had one is noise in a config that is
    // still hand-edited, and parseConfig treats absent and empty alike.
    ...(Object.keys(config.databases ?? {}).length === 0 ? {} : { databases: config.databases }),
    // Same rule as `databases:` above — written only when a project
    // actually has editor roots, so a file that never had the key does not
    // grow an empty one on the first save.
    ...(Object.keys(config.editors ?? {}).length === 0 ? {} : { editors: config.editors }),
    // Same rule as `databases:` and `editors:` above — written only when
    // there is something to write, and guarded because validateDraft hands
    // this function renderer-supplied data cast to JarvisConfig, which an
    // older renderer may not have filled in.
    ...(Object.keys(config.clusters ?? {}).length === 0 ? {} : { clusters: config.clusters }),
    // Same rule as `clusters:` above — written only when a project actually
    // declares containers, and guarded for the same reason: a draft that
    // reached here from an older renderer may not have the key at all.
    ...(Object.keys(config.docker ?? {}).length === 0 ? {} : { docker: config.docker }),
    // Same rule as `docker:` above. This line is the whole reason a new
    // per-project section is not done when it parses: `toRawConfig` is the
    // sole allowlist of keys that reach the file, so a section missing from
    // it is deleted on the next save — which is what 5d70188 fixed for
    // `docker:` and what settings-io.test.ts now guards for both.
    ...(Object.keys(config.chat ?? {}).length === 0 ? {} : { chat: config.chat }),
    ...(config.headlamp?.binary === undefined
      ? {}
      : { headlamp: { binary: config.headlamp.binary } }),
    // Written only when it says something the defaults do not, by the same
    // rule as `databases:` above — but present here for the reason the
    // `chat:` comment gives: this function is the sole allowlist of keys
    // that reach the file, so a section left out of it is deleted on the
    // next save. A `performance:` block silently wiped by opening Settings
    // is exactly that bug.
    ...(isDefault(config.performance, DEFAULT_PERFORMANCE)
      ? {}
      : { performance: config.performance }),
    ...(isDefault(config.browser, DEFAULT_BROWSER) ? {} : { browser: config.browser }),
    // The three sections below were missing from this list until 2026-09-06,
    // which meant every save through the Settings route silently deleted
    // them from the user's jarvis.yaml — recoverable only from the
    // timestamped backup, and only if you noticed. settings-io.test.ts now
    // derives the expected key list from JarvisConfig itself, so a section
    // added later cannot be forgotten the same way.
    ...(Object.keys(config.workflows ?? {}).length === 0 ? {} : { workflows: config.workflows }),
    ...(isDefault(config.terminal, DEFAULT_TERMINAL) ? {} : { terminal: config.terminal }),
    ...(isDefault(config.sessions, DEFAULT_SESSIONS) ? {} : { sessions: config.sessions }),
    brain: {
      ...(config.brain.accountId === undefined ? {} : { accountId: config.brain.accountId }),
      cwd: config.brain.cwd,
      systemPrompt: config.brain.systemPrompt,
    },
    voice: config.voice,
    whisper: config.whisper,
  };
}

/**
 * Validates, backs up whatever is currently at `path` (if anything), then
 * overwrites it with the validated draft. A draft that fails validation
 * never reaches the filesystem at all — the existing file is left exactly
 * as it was, backup or no backup.
 */
export async function writeSettingsFile(path: string, draft: JarvisConfig): Promise<SettingsWriteResult> {
  const validated = validateDraft(draft);
  if (!validated.ok) return validated;

  try {
    await readFile(path, "utf8");
    // A file exists — keep it, timestamped, before it is overwritten.
    await copyFile(path, `${path}.bak-${Date.now()}`);
  } catch {
    // Nothing to back up — this is the first time Settings has ever
    // written this file (or it was deleted out from under Jarvis; either
    // way, there is nothing to preserve).
  }

  await writeFile(path, stringify(toRawConfig(validated.value)), "utf8");
  return { ok: true };
}
