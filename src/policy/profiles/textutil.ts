import type { SyntaxNode } from "../../parser/node";
import type { Invocation, UnitSeed } from "../types";
import { pathEffects, unsupported } from "./helpers";

// textutil (macOS) document conversion, read-only form only: exactly one
// `-convert FMT` with a closed format enum plus `-stdout`, so the
// converted document goes to stdout and never to a file. Every writing
// shape — `-convert` without `-stdout` (writes OUTFILE), `-output/-o`,
// `-cat`, `-stdin` — is excluded by the grammar itself: -stdout must be
// present, no other option is recognized, and at least one file operand
// must remain.
const FORMATS = new Set([
  "txt",
  "html",
  "rtf",
  "rtfd",
  "doc",
  "docx",
  "odt",
  "word",
  "wordhtml",
  "webarchive",
]);

export function recognizeTextutil(
  node: SyntaxNode,
  invocation: Invocation,
): UnitSeed {
  const args = invocation.args.map((argument) => argument.literal);
  if (args.some((argument) => argument === undefined))
    return unsupported(node, "dynamic textutil");
  const values = args as string[];
  if (values.length === 0) return unsupported(node, "missing textutil form");
  if (values.length === 1 && values[0] === "-help")
    return {
      kind: "command",
      text: node.text,
      situation: "workspace-neutral-or-indeterminate",
      allowed: true,
      reason: "textutil usage form",
    };
  let convert = false;
  let stdout = false;
  const files: string[] = [];
  for (let index = 0; index < values.length; index++) {
    const value = values[index]!;
    if (value === "-convert") {
      const format = values[++index];
      if (!format || !FORMATS.has(format))
        return unsupported(node, "unsupported textutil format");
      convert = true;
      continue;
    }
    if (value === "-stdout") {
      stdout = true;
      continue;
    }
    if (value.startsWith("-"))
      return unsupported(node, "unsupported textutil option");
    files.push(value);
  }
  if (!stdout) return unsupported(node, "textutil requires -stdout");
  if (!convert) return unsupported(node, "textutil requires -convert");
  if (files.length === 0)
    return unsupported(node, "missing textutil file operand");
  return pathEffects(node, files, "read", "textutil");
}
