import type { SyntaxNode } from "../../parser/node";
import type { Invocation, UnitSeed } from "../types";
import { pathEffects, unsupported } from "./helpers";

// plutil (macOS) read-only query forms only: -lint (also the documented
// default operation when no operation argument is given), -p, -type,
// -extract, and -help. Every plist-writing form — -convert (writes the
// converted plist back to the input file), -insert/-replace/-remove/
// -create, and the -o/-e output redirections — is excluded by the grammar
// itself so no write can ride along the read whitelist. `-` is ambiguous
// in plutil (option separator vs stdin operand) and stays unsupported;
// -s/-r are convert-side modifiers and stay unsupported with it.
const EXTRACT_FORMATS = new Set([
  "xml1",
  "binary1",
  "json",
  "swift",
  "objc",
  "raw",
]);
const EXPECT_TYPES = new Set([
  "bool",
  "integer",
  "float",
  "string",
  "date",
  "data",
  "array",
  "dictionary",
]);

export function recognizePlutil(
  node: SyntaxNode,
  invocation: Invocation,
): UnitSeed {
  const args = invocation.args.map((argument) => argument.literal);
  if (args.some((argument) => argument === undefined))
    return unsupported(node, "dynamic plutil");
  const values = args as string[];
  if (values.length === 0) return unsupported(node, "missing plutil operand");
  const head = values[0]!;
  if (head === "-help") {
    return values.length === 1
      ? {
          kind: "command",
          text: node.text,
          situation: "workspace-neutral-or-indeterminate",
          allowed: true,
          reason: "plutil usage form",
        }
      : unsupported(node, "unsupported plutil form");
  }
  if (head === "-lint" || head === "-p")
    return readFiles(node, values.slice(1));
  if (head === "-type" || head === "-extract")
    return recognizeKeyPathRead(node, head, values.slice(1));
  if (!head.startsWith("-")) return readFiles(node, values);
  return unsupported(node, "unsupported plutil option");
}

function readFiles(node: SyntaxNode, operands: string[]): UnitSeed {
  if (operands.length === 0)
    return unsupported(node, "missing plutil file operand");
  if (operands.some((operand) => operand.startsWith("-")))
    return unsupported(node, "unsupported plutil option");
  return pathEffects(node, operands, "read", "plutil");
}

function recognizeKeyPathRead(
  node: SyntaxNode,
  operation: string,
  tokens: string[],
): UnitSeed {
  const keypath = tokens[0];
  if (!keypath || keypath.startsWith("-"))
    return unsupported(node, "missing plutil keypath");
  let index = 1;
  if (operation === "-extract") {
    const format = tokens[index];
    index += 1;
    if (!format || !EXTRACT_FORMATS.has(format))
      return unsupported(node, "unsupported plutil format");
  }
  const files: string[] = [];
  for (; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.startsWith("-")) {
      if (files.length > 0)
        return unsupported(node, "unsupported plutil option");
      if (token === "-expect") {
        const type = tokens[++index];
        if (!type || !EXPECT_TYPES.has(type))
          return unsupported(node, "unsupported plutil expect type");
        continue;
      }
      if (operation === "-extract" && token === "-n") continue;
      return unsupported(node, "unsupported plutil option");
    }
    files.push(token);
  }
  if (files.length === 0)
    return unsupported(node, "missing plutil file operand");
  return pathEffects(node, files, "read", "plutil");
}
