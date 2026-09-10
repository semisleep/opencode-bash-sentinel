import path from "node:path";

// A conservative, high-signal set of paths whose *read* must not be
// auto-approved as an external read (ADR-0002). Home-relative entries expand
// against the supplied home directory; absolute entries are used as-is.
//
// This is deliberately best-effort and incomplete: it is not a completeness
// claim. Because the default for external reads remains allow, a path that is
// not listed simply keeps today's behavior rather than gaining a false
// guarantee. Matching is lexical, consistent with workspace containment, so a
// symlink pointing at one of these roots is not caught.
const DEFAULT_HOME_ROOTS = [
  ".ssh",
  ".aws",
  ".gnupg",
  ".kube",
  ".docker/config.json",
  ".config/gcloud",
  ".config/gh",
  ".netrc",
  ".git-credentials",
  ".npmrc",
  ".pypirc",
  "Library/Keychains",
] as const;

const DEFAULT_ABSOLUTE_ROOTS = ["/etc/shadow"] as const;

const defaultCache = new Map<string, readonly string[]>();

function defaultRoots(homedir: string): readonly string[] {
  let roots = defaultCache.get(homedir);
  if (!roots) {
    roots = [
      ...DEFAULT_HOME_ROOTS.map((entry) => path.join(homedir, entry)),
      ...DEFAULT_ABSOLUTE_ROOTS.map((entry) => path.normalize(entry)),
    ];
    defaultCache.set(homedir, roots);
  }
  return roots;
}

function expand(root: string, homedir: string): string {
  if (root === "~") return path.normalize(homedir);
  if (root.startsWith("~/")) return path.normalize(path.join(homedir, root.slice(2)));
  return path.normalize(root);
}

/**
 * True when a resolved path equals, or lies under, a sensitive root. `extraRoots`
 * are additive user-supplied roots (union with the defaults); they can only add
 * matches, never remove a default, keeping the rule fail-closed.
 */
export function isSensitiveTarget(
  resolvedPath: string,
  homedir: string,
  extraRoots: readonly string[] = [],
): boolean {
  const value = path.normalize(resolvedPath);
  const roots = [
    ...defaultRoots(homedir),
    ...extraRoots.map((root) => expand(root, homedir)),
  ];
  return roots.some(
    (root) => value === root || value.startsWith(root + path.sep),
  );
}
