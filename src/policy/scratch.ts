import path from "node:path";
import { stripTrailingSeparators } from "./paths";

// ADR-0004 scratch roots: a host-supplied set of external directories
// (system temp locations) where recognized mutations may auto-approve.
// The allowance admits only strict descendants of a root — equality is the
// scratch-root deletion red line — and it is subordinate to the ADR-0002
// sensitive-read red line, which is evaluated first in the situation-2
// branch. Symlinks are not canonicalized. The engine ships no defaults: the
// host supplies the list, and an absent or empty list reproduces the
// pre-ADR-0004 behavior exactly (external mutations ask).
//
// Allow-direction matching discipline, mirroring `withinWorkspace` and
// `samePath` rather than `isSensitiveTarget`: comparison is exact-case and
// trailing separators are stripped. The sensitive red line folds case and
// tolerates trailing separators because an extra match there only widens
// toward ask; here an extra match would widen toward allow — case folding
// would approve "/TMP" as "/tmp" on a case-sensitive filesystem, and a raw
// trailing separator would turn the root itself into a "descendant",
// defeating the scratch-root deletion red line.

export function isScratchDescendant(
  resolvedPath: string,
  scratchRoots: readonly string[] = [],
): boolean {
  const value = canonical(resolvedPath);
  return scratchRoots.some(
    (root) => value.startsWith(canonical(root) + path.sep),
  );
}

export function isScratchRoot(
  resolvedPath: string,
  scratchRoots: readonly string[] = [],
): boolean {
  const value = canonical(resolvedPath);
  return scratchRoots.some((root) => value === canonical(root));
}

function canonical(value: string): string {
  return stripTrailingSeparators(path.normalize(value));
}
