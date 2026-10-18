import type { SyntaxNode } from "../../parser/node";
import type { Invocation, UnitSeed } from "../types";
import { globReadTarget, pathEffects, unsupported } from "./helpers";

// Print-only awk: patterns (/re/ matching, field and NR comparisons,
// && || !) and print/printf actions over stdin or named files whose
// only output goes to stdout. The program text is screened as data, so
// the grammar excludes by construction:
//   - output redirection — `>` survives only as `>=` or strictly inside
//     parentheses, where awk grammar admits comparisons but never a
//     `print > FILE` redirect (which can only follow print outside them);
//   - command pipes — a single `|` is a print/printf pipe or coprocess;
//     only the logical-or `||` pair passes;
//   - process and file I/O builtins as whole words (system, getline,
//     close, fflush, readfile, popen) and the ambient-data arrays
//     (ENVIRON, ARGV), the latter because ARGV[1]="…" can add input
//     files at runtime that no static operand check sees;
//   - every backslash, so escape-heavy programs stay unreviewed;
//   - any option beyond -F separators, -v in-process assignments, and
//     the usage forms — `-f progfile` loads an invisible program and
//     stays fail-closed.
// File operands are reads exactly like grep's (literals or bounded
// globs), so external-read and sensitive-root rules classify them the
// same as any other reader.
const CHARSET = /^[A-Za-z0-9 $"()*+,\-./:;<=>[\]^_{}|&%!~'#]+$/;
const FORBIDDEN = /\b(?:system|getline|close|fflush|readfile|popen|ENVIRON|ARGV)\b/;

type Entry = { literal: string } | { glob: string };

function literalAt(args: Entry[], index: number): string | undefined {
  const entry = args[index];
  return entry && "literal" in entry ? entry.literal : undefined;
}

export function recognizeAwk(
  node: SyntaxNode,
  invocation: Invocation,
): UnitSeed {
  const parsed: (Entry | undefined)[] = invocation.args.map((argument) => {
    if (argument.literal !== undefined) return { literal: argument.literal };
    const glob = globReadTarget(argument.raw);
    return glob === undefined ? undefined : { glob };
  });
  if (parsed.some((entry) => entry === undefined))
    return unsupported(node, "dynamic awk");
  const args = parsed as Entry[];
  let program: string | undefined;
  let usageForm = false;
  const files: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const entry = args[index]!;
    if (!("literal" in entry)) {
      // A glob can only be a file operand, never the program.
      if (program === undefined)
        return unsupported(node, "dynamic awk program");
      files.push(entry.glob);
      continue;
    }
    const value = entry.literal;
    if (value === "--help" || value === "--version") {
      usageForm = true;
      continue;
    }
    if (value === "-F" || value === "--field-separator") {
      if (!literalAt(args, ++index))
        return unsupported(node, "missing awk separator");
      continue;
    }
    if (value.startsWith("-F") && value.length > 2) continue;
    if (value === "-v" || value === "--assign") {
      if (!/^[A-Za-z_][A-Za-z0-9_]*=.+/.test(literalAt(args, ++index) ?? ""))
        return unsupported(node, "unsupported awk assignment");
      continue;
    }
    if (/^-v[A-Za-z_][A-Za-z0-9_]*=.+/.test(value)) continue;
    if (value.startsWith("-"))
      return unsupported(node, "unsupported awk option");
    if (program === undefined) {
      program = value;
      continue;
    }
    files.push(value);
  }
  // A usage flag never launders an unscreened program: the screen runs
  // first, and only then does the print-and-exit form allow.
  if (program !== undefined && !safePrintProgram(program))
    return unsupported(node, "unsupported awk program");
  if (usageForm)
    return {
      kind: "command",
      text: node.text,
      situation: "workspace-neutral-or-indeterminate",
      allowed: true,
      reason: "awk usage form",
    };
  if (program === undefined) return unsupported(node, "missing awk program");
  return files.length
    ? pathEffects(node, files, "read", "awk")
    : {
        kind: "command",
        text: node.text,
        situation: "workspace-neutral-or-indeterminate",
        allowed: true,
        reason: "awk stdin",
      };
}

function safePrintProgram(program: string): boolean {
  if (program === "" || !CHARSET.test(program) || FORBIDDEN.test(program))
    return false;
  let depth = 0;
  for (let index = 0; index < program.length; index++) {
    const character = program[index]!;
    if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth < 0) return false;
    } else if (character === "|") {
      // `||` is logical-or; any single `|` (pipe or `|&` coprocess) is
      // process I/O and refuses the program.
      if (program[index + 1] !== "|") return false;
      index += 1;
    } else if (character === ">") {
      // `>=` compares anywhere; a bare `>` outside parentheses is an
      // output redirect, while inside them awk grammar permits only
      // the comparison form.
      if (program[index + 1] !== "=" && depth <= 0) return false;
    }
  }
  return depth === 0;
}
