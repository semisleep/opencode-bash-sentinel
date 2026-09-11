import type { SyntaxNode } from "../../parser/node";
import type { Invocation, UnitSeed } from "../types";
import { pathEffects, unsupported } from "./helpers";

export const SEARCH_NAMES = new Set(["rg", "ripgrep", "grep"]);

// -E and -r are valueless for grep but value-taking in ripgrep (--encoding,
// --replace), so grep gets its own wider class of valueless read-only flags.
const SHORT_OPTIONS = {
  grep: /^-[nHhIiSsUvVwcClLoEaqxbPrR]+$/,
  default: /^-[nHhIiSsUvVwcClLo]+$/,
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
      if (
        !(name === "grep"
          ? SHORT_OPTIONS.grep
          : SHORT_OPTIONS.default
        ).test(value) &&
        ![
          "--hidden",
          "--follow",
          "--count",
          "--line-number",
          "--no-heading",
          "--fixed-strings",
        ].includes(value)
      )
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
