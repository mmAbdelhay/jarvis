// The lock state's copy outside memory (Rafiq M3 §2, §3). It lives in
// $XDG_RUNTIME_DIR (tmpfs, per login), so a reboot never leaves a fresh login
// locked, while a jarvisd restart during a lock stays locked. Fails closed:
// anything but a clean {"locked": false} or a missing file reads as locked.
//
// No electron here (core/no-electron.test.ts).
export type LockStore = { read(): Promise<boolean>; write(locked: boolean): Promise<void> };

const isMissing = (error: unknown) => (error as { code?: unknown } | null)?.code === "ENOENT";

export function createLockStore(
  path: string,
  fs: {
    readFile(path: string): Promise<string>;
    writeFile(path: string, text: string): Promise<void>;
  },
): LockStore {
  return {
    async read() {
      let text: string;
      try {
        text = await fs.readFile(path);
      } catch (error) {
        return !isMissing(error);
      }
      try {
        const value: unknown = JSON.parse(text);
        const locked =
          typeof value === "object" && value !== null
            ? (value as Record<string, unknown>)["locked"]
            : undefined;
        return typeof locked === "boolean" ? locked : true;
      } catch {
        return true;
      }
    },
    write: (locked) => fs.writeFile(path, `${JSON.stringify({ locked })}\n`),
  };
}
