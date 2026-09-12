import type { SyntaxNode } from "../../parser/node";
import type { Invocation, UnitSeed } from "../types";
import { pathEffects, unsupported } from "./helpers";

// jq's filter language has no file or process side effects: the filter is
// data, and only explicit file operands (plus -f/--slurpfile/--rawfile
// values) name things to read. `--args`/`--jsonargs` are deliberately out:
// they turn every following operand into program data, so file operands
// could no longer be positively identified as reads.
const VALUELESS_OPTIONS = new Set([
  "-c",
  "--compact-output",
  "-r",
  "--raw-output",
  "-j",
  "--join-output",
  "-a",
  "--ascii-output",
  "-S",
  "--sort-keys",
  "-C",
  "--color-output",
  "-M",
  "--monochrome-output",
  "-n",
  "--null-input",
  "-s",
  "--slurp",
  "-e",
  "--exit-status",
  "-R",
  "--raw-input",
  "--tab",
  "--stream",
  "--seq",
  "--unbuffered",
  "--version",
]);

export function recognizeJq(
  node: SyntaxNode,
  invocation: Invocation,
): UnitSeed {
  const args = invocation.args.map((argument) => argument.literal);
  if (args.some((argument) => argument === undefined))
    return unsupported(node, "dynamic jq");
  const values = args as string[];
  const files: string[] = [];
  let version = false;
  let filterFromFile = false;
  let index = 0;
  for (; index < values.length; index++) {
    const value = values[index]!;
    if (value === "--") {
      index += 1;
      break;
    }
    if (value === "-" || !value.startsWith("-")) break;
    if (VALUELESS_OPTIONS.has(value)) {
      if (value === "--version") version = true;
      continue;
    }
    if (value === "-f" || value === "--from-file") {
      const file = values[++index];
      if (!file) return unsupported(node, "missing jq option value");
      files.push(file);
      filterFromFile = true;
      continue;
    }
    if (value === "--slurpfile" || value === "--rawfile") {
      const name = values[++index];
      const file = values[++index];
      if (!name || !file) return unsupported(node, "missing jq option value");
      files.push(file);
      continue;
    }
    if (value === "--arg" || value === "--argjson") {
      const name = values[++index];
      const data = values[++index];
      if (!name || data === undefined)
        return unsupported(node, "missing jq option value");
      continue;
    }
    if (value === "--indent") {
      if (!/^\d+$/.test(values[++index] ?? ""))
        return unsupported(node, "unsupported jq option");
      continue;
    }
    if (value.startsWith("--indent=")) {
      if (!/^\d+$/.test(value.slice(9)))
        return unsupported(node, "unsupported jq option");
      continue;
    }
    return unsupported(node, "unsupported jq option");
  }
  const operands = values.slice(index);
  if (operands[0] === undefined && !version && !filterFromFile)
    return unsupported(node, "missing jq filter");
  files.push(...operands.slice(1));
  return files.length
    ? pathEffects(node, files, "read", "jq")
    : {
        kind: "command",
        text: node.text,
        situation: "workspace-neutral-or-indeterminate",
        allowed: true,
        reason: "jq stdin",
      };
}
