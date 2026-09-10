import type { SyntaxNode } from "../../../parser/node";
import type { Effect, Invocation, UnitSeed } from "../../types";
import { unsupported } from "../helpers";
import {
  literalArguments,
  parseArguments,
  type OptionGrammar,
} from "./options";

const GRAMMARS: Record<string, OptionGrammar> = {
  cp: {
    short: "adfHilLnPrRuvx",
    long: new Set([
      "--archive",
      "--force",
      "--interactive",
      "--link",
      "--no-clobber",
      "--recursive",
      "--reflink",
      "--symbolic-link",
      "--update",
      "--verbose",
    ]),
  },
  mv: {
    short: "finuv",
    long: new Set([
      "--force",
      "--interactive",
      "--no-clobber",
      "--no-target-directory",
      "--update",
      "--verbose",
    ]),
  },
  ln: {
    short: "dfinPrsv",
    long: new Set([
      "--force",
      "--interactive",
      "--no-dereference",
      "--no-target-directory",
      "--relative",
      "--symbolic",
      "--verbose",
    ]),
  },
};

export function recognizeFilesystemTransfer(
  node: SyntaxNode,
  invocation: Invocation,
  name: string,
): UnitSeed | undefined {
  const grammar = GRAMMARS[name];
  if (!grammar) return;
  const args = literalArguments(invocation);
  if (!args) return unsupported(node, `dynamic ${name}`);
  const parsed = parseArguments(args, grammar);
  if (!parsed || parsed.operands.length < 2)
    return unsupported(node, `unsupported ${name}`);
  const sources = parsed.operands.slice(0, -1);
  const destination = parsed.operands.at(-1)!;
  const sourceKind = name === "mv" ? "move-source" : "read";
  const destinationKind = name === "mv" ? "move-destination" : "write";
  return {
    kind: "command",
    text: node.text,
    effects: [
      { kind: sourceKind, path: sources[0]! },
      ...sources
        .slice(1)
        .map((item): Effect => ({ kind: sourceKind, path: item })),
      { kind: destinationKind, path: destination },
    ],
    reason: name,
  };
}
