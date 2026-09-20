import type { SyntaxNode } from "../../parser/node";
import type { Invocation, UnitSeed } from "../types";
import { unsupported } from "./helpers";

// brew read-only surface only: `list`/`ls` (with --versions, -1,
// --formula/--formulae, --cask/--casks, and literal formula names) and
// `info`/`abv` (literal names), plus the bare --version/--prefix usage
// forms. brew's management verbs (install, uninstall, update, upgrade,
// tap, services, …) run package lifecycle code or mutate state and are
// excluded by the subcommand whitelist itself; formula-name operands are
// catalogue keys, not paths, so the unit carries no filesystem effect
// (situation 3).
const LIST_ACTIONS = new Set(["list", "ls"]);
const LIST_FLAGS = new Set([
  "--versions",
  "-1",
  "--formula",
  "--formulae",
  "--cask",
  "--casks",
]);

export function recognizeBrew(
  node: SyntaxNode,
  invocation: Invocation,
): UnitSeed {
  const args = invocation.args.map((argument) => argument.literal);
  if (args.some((argument) => argument === undefined))
    return unsupported(node, "dynamic brew");
  const values = args as string[];
  const head = values[0];
  if (head === undefined) return unsupported(node, "missing brew subcommand");
  if (head === "--version" || head === "--prefix")
    return values.length === 1
      ? listing(node)
      : unsupported(node, "unsupported brew form");
  const listingAction = LIST_ACTIONS.has(head);
  if (!listingAction && head !== "info" && head !== "abv")
    return unsupported(node, "unsupported brew subcommand");
  for (const value of values.slice(1)) {
    if (value.startsWith("-")) {
      if (listingAction && LIST_FLAGS.has(value)) continue;
      return unsupported(node, "unsupported brew option");
    }
  }
  return listing(node);
}

function listing(node: SyntaxNode): UnitSeed {
  return {
    kind: "command",
    text: node.text,
    situation: "workspace-neutral-or-indeterminate",
    allowed: true,
    reason: "brew read-only listing",
  };
}
