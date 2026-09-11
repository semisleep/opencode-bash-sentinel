import type { SyntaxNode } from "../../parser/node";
import type { Invocation, UnitSeed } from "../types";
import { pathEffects, unsupported } from "./helpers";

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
      "--line-number",
      "--no-heading",
      "--fixed-strings",
      "--text",
    ]),
  },
} as const;

export function recognizeSearch(
  node: SyntaxNode,
  invocation: Invocation,
  name: string,
): UnitSeed {
  const args = invocation.args.map((argument) => argument.literal);
  if (args.some((argument) => argument === undefined))
    return unsupported(node, `dynamic ${name}`);
  const paths: string[] = [];
  let hasPattern = false;
  let filesMode = false;
  const values = args as string[];
  for (let index = 0; index < values.length; index++) {
    const value = values[index]!;
    if (value === "--") {
      if (filesMode) {
        paths.push(...values.slice(index + 1));
        break;
      }
      if (!hasPattern) {
        if (!values[index + 1])
          return unsupported(node, `missing ${name} pattern`);
        hasPattern = true;
        index++;
      }
      paths.push(...values.slice(index + 1));
      break;
    }
    if (!hasPattern && value.startsWith("-")) {
      if (value === "--files") {
        if (name === "grep")
          return unsupported(node, "unsupported grep option");
        filesMode = true;
        continue;
      }
      if (["-e", "--regexp", "-g", "--glob", "-t", "--type"].includes(value)) {
        if (!values[++index])
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
        if (!/^\d+$/.test(values[++index] ?? ""))
          return unsupported(node, `unsupported ${name} option`);
        continue;
      }
      if (/^--(?:after-context|before-context)=\d+$/.test(value)) continue;
      // rg's -r/--replace only rewrites matched text on stdout; grep's -r is
      // valueless recursion and stays in grep's cluster set below.
      if (name !== "grep") {
        if (value === "-r" || value === "--replace") {
          if (!values[++index])
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
  if (!hasPattern && !filesMode)
    return unsupported(node, `missing ${name} pattern`);
  return paths.length
    ? pathEffects(node, paths, "read", name)
    : {
        kind: "command",
        text: node.text,
        situation: "workspace-neutral-or-indeterminate",
        allowed: true,
        reason: `${name} cwd search`,
      };
}
