import type { SyntaxNode } from "../../../parser/node";
import type { Effect, Invocation, UnitSeed } from "../../types";
import { pathEffects, unsupported } from "../helpers";
import {
  literalArguments,
  parseArguments,
  type OptionGrammar,
} from "./options";

const GRAMMARS: Record<string, OptionGrammar> = {
  mkdir: {
    short: "pv",
    shortWithValue: "m",
    long: new Set(["--parents", "--verbose"]),
  },
  touch: {
    short: "acm",
    shortWithValue: "rt",
    long: new Set(["--no-create"]),
  },
  truncate: { short: "cov", shortWithValue: "rs" },
  shred: { short: "fvxz", shortWithValue: "ns" },
  tee: {
    short: "ai",
    long: new Set(["--append", "--ignore-interrupts"]),
  },
};

export function recognizeFilesystemWriter(
  node: SyntaxNode,
  invocation: Invocation,
  name: string,
): UnitSeed | undefined {
  const grammar = GRAMMARS[name];
  if (!grammar) return;
  const args = literalArguments(invocation);
  if (!args) return unsupported(node, `dynamic ${name}`);
  const parsed = parseArguments(args, grammar);
  if (!parsed) return unsupported(node, `unsupported ${name}`);
  if (name !== "tee" && parsed.operands.length === 0)
    return unsupported(node, `missing ${name} operand`);

  const referenceReads =
    name === "touch" || name === "truncate"
      ? [...(parsed.optionValues.get("-r") ?? [])]
      : [];
  if (referenceReads.length === 0)
    return pathEffects(node, parsed.operands, "write", name);
  return {
    kind: "command",
    text: node.text,
    effects: [
      ...referenceReads.map((item): Effect => ({ kind: "read", path: item })),
      ...parsed.operands.map((item): Effect => ({ kind: "write", path: item })),
    ] as [Effect, ...Effect[]],
    reason: name,
  };
}
