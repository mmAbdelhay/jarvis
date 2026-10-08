// The graphical session's environment for jarvisd's MCP servers (Rafiq M3
// contracts §5.14). jarvisd is a user unit WantedBy=default.target, so it can
// start before labwc's autostart runs `systemctl --user import-environment
// WAYLAND_DISPLAY DISPLAY XDG_CURRENT_DESKTOP`, and a restarted compositor
// changes them again. jarvisd reads them back from `systemctl --user
// show-environment` and, when they change, restarts its host servers before
// the next turn (agent-service.ts), so jarvis-apps (xdg-open, xdg-mime) and
// jarvis-settings never run with a missing or stale display.
//
// No electron here (core/no-electron.test.ts).

/** Exactly what labwc's autostart imports into the user manager. */
export const SESSION_KEYS = ["WAYLAND_DISPLAY", "DISPLAY", "XDG_CURRENT_DESKTOP"] as const;

/** `systemctl --user show-environment`: KEY=VALUE per line; values with
 *  special characters come as $'...' with backslash escapes. */
export function parseShowEnvironment(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (match === null) continue;
    const [, key = "", raw = ""] = match;
    out[key] = raw.startsWith("$'") && raw.endsWith("'") ? unescapeAnsiC(raw.slice(2, -1)) : raw;
  }
  return out;
}

const ESCAPES: Record<string, string> = {
  n: "\n",
  t: "\t",
  r: "\r",
  "\\": "\\",
  "'": "'",
  '"': '"',
};

function unescapeAnsiC(body: string): string {
  return body.replace(/\\(.)/g, (whole, ch: string) => ESCAPES[ch] ?? whole);
}

export type SessionEnv = {
  /** jarvisd's environment with the session variables last read merged in. */
  current(): NodeJS.ProcessEnv;
  /** Re-reads the user manager; true when a session variable changed. A
   *  failed read keeps the last environment and reports no change. */
  changed(): Promise<boolean>;
};

export function createSessionEnv(options: {
  base: NodeJS.ProcessEnv;
  /** show-environment's stdout, or undefined when it could not run. */
  read(): Promise<string | undefined>;
}): SessionEnv {
  let env: NodeJS.ProcessEnv = { ...options.base };
  return {
    current: () => env,
    async changed() {
      let text: string | undefined;
      try {
        text = await options.read();
      } catch {
        return false;
      }
      if (text === undefined) return false;
      const session = parseShowEnvironment(text);
      const next: NodeJS.ProcessEnv = { ...env };
      let changed = false;
      for (const key of SESSION_KEYS) {
        const value = session[key];
        if (value === undefined) delete next[key];
        else next[key] = value;
        if (next[key] !== env[key]) changed = true;
      }
      env = next;
      return changed;
    },
  };
}
