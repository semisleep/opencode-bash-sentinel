import path from "node:path";
import type { SyntaxNode } from "../../parser/node";
import { looksLikePath, resolvePath, withinWorkspace } from "../paths";
import type { Effect, UnitSeed, WorkspaceContext } from "../types";

// A shell pathname glob is acceptable as a read operand only when a literal
// prefix bounds every expansion. Bash wildcards never match a filename's
// leading dot, so a component like `foo*` expands to names starting with
// `foo` — never `.`/`..` (which could climb the bound) — while a
// dot-prefixed wildcard can: `.*`, `..*`, and `.?*` expand to `.`/`..`
// themselves (`src/.*` reaches `src/..`). A dot-prefixed component is
// therefore bounded only when its literal prefix before the first wildcard
// names something other than `.`/`..`: `.env*`, `.env.*`, and `...*` can
// never complete to them (verified against bash). Bracket classes cannot
// match a leading dot in bash, so `[.]*`-style components stay bounded.
// Expansion, brace, and extglob material is refused, as is any literal
// `..` component behind the first wildcard: shell-side
// normalization could climb it out of the prefix bound. The read
// conservatively covers the literal directory prefix, or the cwd for a
// bare filename glob; both classify like any other read operand.
export function globReadTarget(raw: string): string | undefined {
  if (raw.startsWith("-")) return;
  if (/[$`{}()\\'"\s;&|<>!^]/.test(raw)) return;
  const wildcard = raw.search(/[*?\[]/);
  if (wildcard < 0) return;
  if (raw.split("/").some(unboundedComponent)) return;
  const slash = raw.lastIndexOf("/", wildcard);
  if (slash < 0) {
    // With no directory component before the first wildcard, a nonempty
    // literal prefix keeps every expansion a cwd child starting with that
    // prefix, so the read covers the cwd.
    if (wildcard === 0 || raw.startsWith("~")) return;
    if (raw.split("/").includes("..")) return;
    return ".";
  }
  if (raw.slice(slash + 1).split("/").includes("..")) return;
  return raw.slice(0, slash + 1);
}

// True for a path component whose wildcard expansion can include `.` or
// `..`, escaping the literal-prefix bound. Only a dot-prefixed component
// qualifies, and only when the literal prefix before its first wildcard is
// exactly `.` or `..` — a longer or mixed prefix (`.env*`, `...*`) pins the
// expansion to names that start with it, which `.`/`..` never do.
function unboundedComponent(part: string): boolean {
  const wildcard = part.search(/[*?\[]/);
  return (
    wildcard >= 0 &&
    part.startsWith(".") &&
    /^\.{1,2}$/.test(part.slice(0, wildcard))
  );
}

export function unsupported(node: SyntaxNode, reason: string): UnitSeed {
  return {
    kind: "command",
    text: node.text,
    situation: "workspace-neutral-or-indeterminate",
    allowed: false,
    reason,
  };
}

export function pathEffects(
  node: SyntaxNode,
  operands: string[] | undefined,
  kind: Effect["kind"],
  reason: string,
): UnitSeed {
  if (!operands) return unsupported(node, `unsupported ${reason}`);
  if (operands.length === 0)
    return {
      kind: "command",
      text: node.text,
      situation: "workspace-neutral-or-indeterminate",
      allowed: true,
      reason: `${reason} without path`,
    };
  return {
    kind: "command",
    text: node.text,
    effects: operands.map((item) => ({ kind, path: item })) as [
      Effect,
      ...Effect[],
    ],
    reason,
  };
}

export function dependencies(
  node: SyntaxNode,
  ctx: WorkspaceContext,
  cwd: string,
  files: string[],
  shape: boolean,
  reason: string,
) {
  const absolute: string[] = [];
  let allowed = shape;
  for (const item of files) {
    const optional = item.startsWith("?");
    const file = path.join(cwd, optional ? item.slice(1) : item);
    const status = ctx.baseline.status(file);
    if (optional && status === "absent") continue;
    absolute.push(file);
    if (status !== "clean") allowed = false;
  }
  return absoluteDependencies(node, ctx, absolute, allowed, reason);
}

export function absoluteDependencies(
  node: SyntaxNode,
  ctx: WorkspaceContext,
  files: string[],
  shape: boolean,
  reason: string,
): UnitSeed {
  const allowed =
    shape &&
    files.length > 0 &&
    files.every((file) => ctx.baseline.status(file) === "clean");
  return {
    kind: "command",
    text: node.text,
    situation: "workspace-neutral-or-indeterminate",
    allowed,
    reason: allowed ? reason : `${reason} requires clean committed files`,
    dependencies: files,
  };
}

// A visible argument forwarded to a trusted entry (direct script or workflow
// `--` tail) is unsafe when it names a path outside the workspace.
export function unsafeVisibleArgument(
  argument: string | undefined,
  ctx: WorkspaceContext,
  cwd: string,
) {
  if (argument === undefined) return true;
  const equals = argument.indexOf("=");
  if (equals > 0) {
    const value = argument.slice(equals + 1);
    if (looksLikePath(value))
      return !withinWorkspace(resolvePath(value, ctx, cwd) ?? "", ctx.workspace);
  }
  if (argument.startsWith("-") && argument.includes("/")) return true;
  return (
    looksLikePath(argument) &&
    !withinWorkspace(resolvePath(argument, ctx, cwd) ?? "", ctx.workspace)
  );
}
