import type { SyntaxNode } from "../../parser/node";
import type { Invocation, UnitSeed } from "../types";
import { unsupported } from "./helpers";

// mdfind is a read-only Spotlight query: it has no writing mode, so the
// query text is pure display data (situation 3). Only positively spelled
// forms allow — `-name NAME`, one bare literal query, or `-h` usage.
// `-live` (an unbounded interactive stream), `-onlyin` and any other
// option stay unsupported so nothing unexpected rides the whitelist.
export function recognizeMdfind(
  node: SyntaxNode,
  invocation: Invocation,
): UnitSeed {
  const args = invocation.args.map((argument) => argument.literal);
  if (args.some((argument) => argument === undefined))
    return unsupported(node, "dynamic mdfind");
  const values = args as string[];
  if (values.length === 0) return unsupported(node, "missing mdfind query");
  if (values.length === 1 && values[0] === "-h")
    return usageForm(node, "mdfind usage form");
  if (values[0] === "-name") {
    const name = values[1];
    if (!name || name.startsWith("-"))
      return unsupported(node, "missing mdfind name");
    if (values.length > 2)
      return unsupported(node, "unsupported mdfind form");
    return usageForm(node, "mdfind name query");
  }
  if (values.length !== 1 || values[0]!.startsWith("-"))
    return unsupported(node, "unsupported mdfind form");
  return usageForm(node, "mdfind query");
}

function usageForm(node: SyntaxNode, reason: string): UnitSeed {
  return {
    kind: "command",
    text: node.text,
    situation: "workspace-neutral-or-indeterminate",
    allowed: true,
    reason,
  };
}
