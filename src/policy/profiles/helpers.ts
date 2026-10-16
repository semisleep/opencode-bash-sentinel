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
// Backslash-escaped ordinary characters — notably `\ ` in paths like
// `~/Library/Application Support/` — are literal in bash and keep the
// bound intact, and so do quoted regions (`"…"`, `'…'`) of ordinary
// text: `"~/Library/Application Support"/*` keeps the literal prefix and
// is unquoted before screening. Every other backslash escape (`\$`,
// `` \` ``, `\"`, `\\`, …) flattens to text indistinguishable from
// genuinely dynamic material and stays refused, and a quoted region
// carrying a wildcard, a backslash, or dynamic material refuses the word
// with it: a quoted wildcard is literal text — not an expansion — so the
// word is not a positively identified glob, and quoting cannot launder
// `$VAR` or `$(…)` past the screen.
export function globReadTarget(argument: string): string | undefined {
  let raw = argument;
  if (/[$`{}()\\'"\s;&|<>!^]/.test(raw)) {
    const unquoted = unquoteQuotedOrdinary(raw);
    if (unquoted === undefined) return;
    raw = unquoted;
  }
  // The glob cover stands in for an operand, so a result that could begin
  // with `-` (e.g. `"-x"a*`) must not ride into operand position as a
  // runtime option either.
  if (raw.startsWith("-")) return;
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

// Resolve shell quoting to the characters bash would pass the command:
// `\c` for ordinary c only (letters, digits, punctuation that is not
// shell-special here, and whitespace other than newline — `\ ` is the
// whole point), and `"…"` / `'…'` regions whose content is ordinary
// text, spaces included. Returns undefined when any remaining character
// is bare dynamic material, when a backslash escapes a dynamic character,
// when a quoted region carries anything but ordinary characters, or when
// the trailing `\` has nothing to escape or a quote is left unclosed.
function unquoteQuotedOrdinary(raw: string): string | undefined {
  let out = "";
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < raw.length; index++) {
    const character = raw[index]!;
    if (quote) {
      if (character === quote) {
        quote = undefined;
        continue;
      }
      // Ordinary characters only — space included (that is the point),
      // but no wildcards (a quoted wildcard is literal text, not an
      // expansion), no backslash, and no dynamic material.
      if (/[$`{}()'"!^;&|<>*?[\]\\]/.test(character)) return;
      if (/\s/.test(character) && character !== " ") return;
      out += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character !== "\\") {
      if (/[$`{}()'"!^;&|<>\s]/.test(character)) return;
      out += character;
      continue;
    }
    const next = raw[++index];
    if (next === undefined || next === "\n") return;
    if (/[$`{}()\\'"!^;&|<>]/.test(next)) return;
    out += next;
  }
  return quote === undefined ? out : undefined;
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
