// File access for the account dirs. removeTree refuses anything that is not
// strictly inside one of the three account roots, so a bug can never delete
// $HOME or jarvis.yaml.
//
// No electron here (core/no-electron.test.ts).
import { access, chmod, mkdir, readFile, rm } from "node:fs/promises";
import { posix } from "node:path";

export type AccountFs = {
  readText(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
  /** Recursive; the leaf and the account root above it end up 0700. */
  makeDir(path: string): Promise<void>;
  removeTree(path: string): Promise<void>;
};

export function accountRoots(home: string): string[] {
  return [
    posix.join(home, ".config", "jarvis", "accounts"),
    posix.join(home, ".local", "share", "jarvis", "clis"),
    posix.join(home, ".cache", "jarvis", "accounts"),
  ];
}

export function insideAccountRoot(home: string, path: string): string | undefined {
  const normal = posix.normalize(path);
  return accountRoots(home).find(
    (root) => normal.startsWith(`${root}/`) && normal.length > root.length + 1,
  );
}

export function nodeAccountFs(home: string): AccountFs {
  return {
    readText: (path) => readFile(path, "utf8"),
    exists: async (path) => {
      try {
        await access(path);
        return true;
      } catch {
        return false;
      }
    },
    async makeDir(path) {
      const root = insideAccountRoot(home, path);
      if (root === undefined) throw new Error(`refusing to create ${path}`);
      await mkdir(path, { recursive: true, mode: 0o700 });
      await chmod(root, 0o700);
      await chmod(path, 0o700);
    },
    async removeTree(path) {
      if (insideAccountRoot(home, path) === undefined)
        throw new Error(`refusing to remove ${path}`);
      await rm(path, { recursive: true, force: true });
    },
  };
}
