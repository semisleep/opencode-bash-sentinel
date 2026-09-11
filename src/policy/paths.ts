import path from "node:path";
import type { WorkspaceContext } from "./types";

export function resolvePath(
  raw: string,
  ctx: WorkspaceContext,
  cwd: string,
): string | undefined {
  if (!raw || /[$`*?[\]{}()]/.test(raw)) return;
  let value = raw.replaceAll("\\", "/");
  if (value === "~") value = ctx.homedir;
  else if (value.startsWith("~/"))
    value = path.join(ctx.homedir, value.slice(2));
  else if (value.startsWith("~")) return;
  return path.normalize(
    path.isAbsolute(value) ? value : path.resolve(cwd, value),
  );
}

export function looksLikePath(value: string) {
  return (
    path.isAbsolute(value) ||
    value === "." ||
    value === ".." ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    // Bash expands any leading tilde (~, ~/, ~user, ~+), so it is a path.
    value.startsWith("~") ||
    value.includes("/")
  );
}

export function hasGitSegment(value: string) {
  return value
    .replaceAll("\\", "/")
    .split("/")
    .some((part) => part.toLowerCase() === ".git");
}

export function withinWorkspace(value: string, workspace: string) {
  const normalizedValue = path.normalize(value);
  const normalizedWorkspace = path.normalize(workspace);
  return (
    normalizedValue === normalizedWorkspace ||
    normalizedValue.startsWith(normalizedWorkspace + path.sep)
  );
}

export function samePath(a: string, b: string) {
  return (
    stripTrailingSeparators(path.normalize(a)) ===
    stripTrailingSeparators(path.normalize(b))
  );
}

// Node's normalize keeps one trailing separator, but path identity for the
// red lines must not depend on that spelling: tab completion routinely
// yields `rm -rf /work/project/`, which names the same root.
export function stripTrailingSeparators(value: string) {
  const stripped = value.replace(/[\\/]+$/, "");
  return stripped === "" ? "/" : stripped;
}

export function pathsOverlap(a: string, b: string) {
  return withinWorkspace(a, b) || withinWorkspace(b, a);
}
