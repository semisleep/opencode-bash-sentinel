import type { SyntaxNode } from "../../parser/node";
import type { Effect, Invocation, UnitSeed } from "../types";
import { unsupported } from "./helpers";
import { literalArguments } from "./filesystem/options";

// sips query class. `-g key` / `--getProperty key` print property values
// to stdout and `-1` / `--oneLine` only reformats that output, so the
// class is a pure read over the file operands (pdfinfo-style: the
// classifier routes external and sensitive targets by itself). Every
// other synopsis function mutates its input or writes a derived file
// (`-s`, `-d`, `-r`, `-z`, `-Z`, `-c`, `-p`, `-f`, `-x`, `-X`,
// `-o/--out`, `--matchTo`, `--repair`, `--loadTag`, ...), or executes
// JavaScript, and stays fail-closed until a concrete need pins its
// grammar. The key is a property identifier, never a path: dots,
// slashes, and option-looking tokens are rejected, so a missing value
// cannot swallow the next flag or file operand. Attached `-gKEY` and
// `--getProperty=key` spellings are undocumented in the man synopsis and
// deliberately stay unsupported.
const DISPLAY_FLAGS = new Set(["-1", "--oneLine"]);
const PROPERTY_KEY = /^[A-Za-z][A-Za-z0-9]*$/;

export function recognizeSips(
  node: SyntaxNode,
  invocation: Invocation,
): UnitSeed {
  const args = literalArguments(invocation);
  if (!args) return unsupported(node, "dynamic sips");
  const files: string[] = [];
  let queried = false;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === "-g" || argument === "--getProperty") {
      const key = args[++index];
      if (!key || !PROPERTY_KEY.test(key))
        return unsupported(node, "unsupported sips query");
      queried = true;
      continue;
    }
    if (DISPLAY_FLAGS.has(argument)) continue;
    if (argument.startsWith("-"))
      return unsupported(node, "unsupported sips option");
    files.push(argument);
  }
  if (!queried || files.length === 0)
    return unsupported(node, "sips requires a query key and file operands");
  return {
    kind: "command",
    text: node.text,
    effects: [
      { kind: "read", path: files[0]! },
      ...files.slice(1).map((file): Effect => ({ kind: "read", path: file })),
    ],
    reason: "sips property query",
  };
}
