import type { SyntaxNode } from "../../parser/node";
import type { Invocation, UnitSeed } from "../types";
import { unsupported } from "./helpers";

// pgrep lists matching processes; the pattern is display data with no
// filesystem target (situation 3). Only the valueless short-flag cluster
// {-f,-i,-l,-n,-o,-x} plus exactly one literal pattern allows. The
// value-taking selectors (-P/-u/-U/-g/-G/-s/-t/-F/…) are deliberately
// not whitelisted, and pkill — the signalling sibling — is not covered
// by this profile at all and keeps asking.
export function recognizePgrep(
  node: SyntaxNode,
  invocation: Invocation,
): UnitSeed {
  const args = invocation.args.map((argument) => argument.literal);
  if (args.some((argument) => argument === undefined))
    return unsupported(node, "dynamic pgrep");
  const values = args as string[];
  let index = 0;
  while (index < values.length && values[index]!.startsWith("-")) {
    if (!/^-[filnox]+$/.test(values[index]!))
      return unsupported(node, "unsupported pgrep option");
    index += 1;
  }
  const pattern = values.slice(index);
  if (pattern.length !== 1 || pattern[0]!.startsWith("-"))
    return unsupported(node, "unsupported pgrep pattern");
  return {
    kind: "command",
    text: node.text,
    situation: "workspace-neutral-or-indeterminate",
    allowed: true,
    reason: "pgrep process listing",
  };
}
