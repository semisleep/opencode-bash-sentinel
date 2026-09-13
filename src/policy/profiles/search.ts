import type { SyntaxNode } from "../../parser/node";
import type { Invocation, UnitSeed } from "../types";
import { globReadTarget, pathEffects, unsupported } from "./helpers";

export const SEARCH_NAMES = new Set(["rg", "ripgrep", "grep"]);

// -E and -r are valueless for grep but value-taking in ripgrep (--encoding,
// --replace), and several rg-only long flags have no grep meaning, so each
// tool gets its own valueless read-only option set.
const OPTION_SETS = {
  grep: {
    short: /^-[nHFhIiSsUvVwcClLoEaqxbPrR]+$/,
    long: new Set([
      "--count",
      "--line-number",
      "--fixed-strings",
      "--extended-regexp",
      "--recursive",
      "--text",
      "--byte-offset",
      "--line-regexp",
      "--quiet",
      "--perl-regexp",
      "--with-filename",
      "--no-filename",
    ]),
  },
  default: {
    short: /^-[anFHhIiSsUvVwcClLo]+$/,
    long: new Set([
      "--hidden",
      "--follow",
      "--count",
      "--include-zero",
      "--line-number",
      "--no-heading",
      "--fixed-strings",
      "--text",
    ]),
  },
} as const;

type Entry = { literal: string } | { glob: string };

function operand(entry: Entry) {
  return "literal" in entry ? entry.literal : entry.glob;
}

function literalAt(args: Entry[], index: number): string | undefined {
  const entry = args[index];
  return entry && "literal" in entry ? entry.literal : undefined;
}

export function recognizeSearch(
  node: SyntaxNode,
  invocation: Invocation,
  name: string,
): UnitSeed {
  const parsed: (Entry | undefined)[] = invocation.args.map((argument) => {
    if (argument.literal !== undefined) return { literal: argument.literal };
    const glob = globReadTarget(argument.raw);
    return glob === undefined ? undefined : { glob };
  });
  if (parsed.some((entry) => entry === undefined))
    return unsupported(node, `dynamic ${name}`);
  const args = parsed as Entry[];
  const paths: string[] = [];
  let hasPattern = false;
  let filesMode = false;
  let helpForm = false;
  for (let index = 0; index < args.length; index++) {
    const entry = args[index]!;
    if (!("literal" in entry)) {
      // A glob is safe only as a path operand, never as the pattern.
      if (!hasPattern && !filesMode)
        return unsupported(node, `dynamic ${name} pattern`);
      paths.push(entry.glob);
      continue;
    }
    const value = entry.literal;
    if (value === "--") {
      const tail = args.slice(index + 1);
      if (filesMode) {
        paths.push(...tail.map(operand));
        break;
      }
      if (!hasPattern) {
        const next = tail[0];
        if (!next || !("literal" in next) || !next.literal)
          return unsupported(node, `missing ${name} pattern`);
        hasPattern = true;
        paths.push(...tail.slice(1).map(operand));
        break;
      }
      paths.push(...tail.map(operand));
      break;
    }
    if (value.startsWith("-")) {
      if (value === "--files") {
        if (name === "grep")
          return unsupported(node, "unsupported grep option");
        filesMode = true;
        continue;
      }
      // rg's --help prints usage and exits; grep is excluded so its class
      // keeps failing closed on the table lookup below.
      if (value === "--help" && name !== "grep") {
        helpForm = true;
        continue;
      }
      if (["-e", "--regexp", "-g", "--glob", "-t", "--type"].includes(value)) {
        if (!literalAt(args, ++index))
          return unsupported(node, `missing ${name} option value`);
        if (value === "-e" || value === "--regexp") hasPattern = true;
        continue;
      }
      // -A/-B take a numeric context width in both tools; the width is
      // display-only, so glued and attached spellings are positively safe.
      if (/^-[AB]\d+$/.test(value)) continue;
      if (
        value === "-A" ||
        value === "-B" ||
        value === "--after-context" ||
        value === "--before-context"
      ) {
        if (!/^\d+$/.test(literalAt(args, ++index) ?? ""))
          return unsupported(node, `unsupported ${name} option`);
        continue;
      }
      if (/^--(?:after-context|before-context)=\d+$/.test(value)) continue;
      // rg's -r/--replace only rewrites matched text on stdout; grep's -r is
      // valueless recursion and stays in grep's cluster set below.
      if (name !== "grep") {
        if (value === "-r" || value === "--replace") {
          if (!literalAt(args, ++index))
            return unsupported(node, `missing ${name} option value`);
          continue;
        }
        if (/^(?:-r.+|--replace=.+)$/.test(value)) continue;
      }
      const options = name === "grep" ? OPTION_SETS.grep : OPTION_SETS.default
      if (!options.short.test(value) && !options.long.has(value))
        return unsupported(node, `unsupported ${name} option`);
      continue;
    }
    if (filesMode) paths.push(value);
    else if (!hasPattern) hasPattern = true;
    else paths.push(value);
  }
  if (!hasPattern && !filesMode && !helpForm)
    return unsupported(node, `missing ${name} pattern`);
  return paths.length
    ? pathEffects(node, paths, "read", name)
    : {
        kind: "command",
        text: node.text,
        situation: "workspace-neutral-or-indeterminate",
        allowed: true,
        reason: helpForm && !hasPattern
          ? `${name} usage form`
          : `${name} cwd search`,
      };
}
