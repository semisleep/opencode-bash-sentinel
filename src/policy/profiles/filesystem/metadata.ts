import type { SyntaxNode } from "../../../parser/node";
import type { Invocation, UnitSeed } from "../../types";
import { pathEffects, unsupported } from "../helpers";
import { literalArguments, parseArguments } from "./options";

const NAMES = new Set(["chmod", "chown"]);

export function recognizeFilesystemMetadata(
  node: SyntaxNode,
  invocation: Invocation,
  name: string,
): UnitSeed | undefined {
  if (!NAMES.has(name)) return;
  const args = literalArguments(invocation);
  if (!args) return unsupported(node, `dynamic ${name}`);
  const parsed = parseArguments(args, {
    short: name === "chmod" ? "cfRv" : "cfhRv",
    long: new Set([
      "--changes",
      "--recursive",
      "--quiet",
      "--silent",
      "--verbose",
    ]),
  });
  if (!parsed || parsed.operands.length < 2)
    return unsupported(node, `unsupported ${name}`);
  return pathEffects(node, parsed.operands.slice(1), "write", name);
}
