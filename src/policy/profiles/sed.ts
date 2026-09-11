import type { SyntaxNode } from "../../parser/node";
import type { Invocation, UnitSeed } from "../types";
import { pathEffects, unsupported } from "./helpers";

/** A deliberately finite profile: substitution and address-print programs. */
export function recognizeSed(
  node: SyntaxNode,
  invocation: Invocation,
): UnitSeed {
  const args = invocation.args.map((argument) => argument.literal);
  if (args.some((argument) => argument === undefined))
    return unsupported(node, "dynamic sed");

  let writesInPlace = false;
  let explicitExpressions = false;
  const programs: string[] = [];
  const files: string[] = [];
  const values = args as string[];
  for (let index = 0; index < values.length; index++) {
    const value = values[index]!;
    if (value === "-i" || value === "--in-place") {
      writesInPlace = true;
      continue;
    }
    if (value.startsWith("-i") || value.startsWith("--in-place="))
      return unsupported(node, "sed backup suffix");
    if (value === "-e" || value === "--expression") {
      explicitExpressions = true;
      const program = values[++index];
      if (!program) return unsupported(node, "missing sed expression");
      programs.push(program);
      continue;
    }
    if (["-n", "-E", "-r"].includes(value)) continue;
    if (value.startsWith("-"))
      return unsupported(node, "unsupported sed option");
    if (!explicitExpressions && programs.length === 0) programs.push(value);
    else files.push(value);
  }
  if (programs.length === 0) return unsupported(node, "missing sed program");
  if (
    !programs.every(
      (program) => safeSubstitution(program) || safePrintProgram(program),
    )
  )
    return unsupported(node, "unsupported sed program");
  return files.length
    ? pathEffects(node, files, writesInPlace ? "write" : "read", "sed")
    : {
        kind: "command",
        text: node.text,
        situation: "workspace-neutral-or-indeterminate",
        allowed: true,
        reason: "sed stdin",
      };
}

function safeSubstitution(program: string) {
  if (program.length < 4 || program[0] !== "s") return false;
  const delimiter = program[1]!;
  if (/\\|\r|\n|[A-Za-z0-9\s]/.test(delimiter)) return false;
  const patternEnd = sectionEnd(program, 2, delimiter);
  if (patternEnd < 0) return false;
  const replacementEnd = sectionEnd(program, patternEnd + 1, delimiter);
  if (replacementEnd < 0) return false;
  const flags = program.slice(replacementEnd + 1);
  return flags === "" || /^(?:[gIpM]|[0-9])+$/.test(flags);
}

function safePrintProgram(program: string) {
  return /^(?:\d+|\$)?(?:,(?:\d+|\$))?p$/.test(program);
}

function sectionEnd(program: string, start: number, delimiter: string) {
  for (let index = start; index < program.length; index++) {
    if (program[index] === "\\") {
      index++;
      continue;
    }
    if (program[index] === delimiter) return index;
  }
  return -1;
}
