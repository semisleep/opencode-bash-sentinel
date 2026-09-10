import type { SyntaxNode } from "../../parser/node";
import type { Effect, Invocation, UnitSeed } from "../types";
import { unsupported } from "./helpers";

export function recognizeDd(node: SyntaxNode, invocation: Invocation): UnitSeed {
  const effects: Effect[] = [];
  for (const argument of invocation.args) {
    const value = argument.literal;
    if (value === undefined) return unsupported(node, "dynamic dd");
    if (value.startsWith("if="))
      effects.push({ kind: "read", path: value.slice(3) });
    else if (value.startsWith("of="))
      effects.push({ kind: "write", path: value.slice(3) });
    else if (!/^[a-z_]+=[^=]+$/i.test(value))
      return unsupported(node, "unsupported dd");
  }
  return effects.length
    ? {
        kind: "command",
        text: node.text,
        effects: effects as [Effect, ...Effect[]],
        reason: "dd",
      }
    : unsupported(node, "dd without path");
}
