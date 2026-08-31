import { realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

/**
 * Whether `childPath` (relative to `root`) really lives under `root` — the
 * containment check ruling P17 requires of every filesystem read reachable
 * from the renderer.
 *
 * A `..` component is not the interesting case; a symlink is. An agent
 * routinely creates files as part of the product it is building, so it can
 * plant a link to ~/.ssh/id_rsa inside a project, and a naive join-and-read
 * would hand that file's contents to the UI. realpath() resolves symlinks,
 * including intermediate ones.
 *
 * Both sides are resolved, not just the child: the root itself is often
 * reached through a symlink (/tmp is one on macOS), and resolving only the
 * child would fail every legitimate path under such a root.
 */
export async function resolvesInside(root: string, childPath: string): Promise<boolean> {
  try {
    const [realRoot, realTarget] = await Promise.all([
      realpath(root),
      realpath(join(root, childPath)),
    ]);
    const rel = relative(realRoot, realTarget);
    return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  } catch {
    // A dangling symlink, or a root that vanished mid-check, cannot be
    // proven safe — so it is refused rather than read.
    return false;
  }
}
