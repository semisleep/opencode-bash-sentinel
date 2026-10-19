import type { SyntaxNode } from "../../parser/node";
import type { Invocation, UnitSeed } from "../types";
import { pathEffects, unsupported } from "./helpers";

// defaults (macOS) read-only forms only: `read [domain|-g|plist] [key]`,
// `read-type DOMAIN KEY`, and `domains`. An optional leading
// `-currentHost` scope flag selects the local ByHost preferences
// subtree; it changes which plist a domain resolves to, never the
// read/write nature of the verb, so the same verb grammar applies
// after it. The `-host NAME` form stays unsupported — unobserved and
// needlessly wider. A plist-path operand carries a
// real filesystem read effect so sensitive-root and external-read rules
// classify it exactly like cat on the same file; a dot-separated domain
// name is a defaults(1) key, not a path, so those queries stay pure
// information (situation 3). Every mutating verb — write, delete,
// rename, rename-localization, import, export — is excluded by the
// grammar itself, and read accepts at most one plain key.
const READ_VERBS = new Set(["read", "read-type"]);

export function recognizeDefaults(
  node: SyntaxNode,
  invocation: Invocation,
): UnitSeed {
  const args = invocation.args.map((argument) => argument.literal);
  if (args.some((argument) => argument === undefined))
    return unsupported(node, "dynamic defaults");
  const values = args as string[];
  const base = values[0] === "-currentHost" ? 1 : 0;
  const head = values[base];
  if (head === undefined) return unsupported(node, "missing defaults verb");
  if (head === "domains")
    return values.length === base + 1
      ? information(node)
      : unsupported(node, "unsupported defaults form");
  if (!READ_VERBS.has(head))
    return unsupported(node, "unsupported defaults verb");
  const target = values[base + 1];
  if (!target || (target.startsWith("-") && target !== "-g"))
    return unsupported(node, "missing defaults domain");
  const key = values[base + 2];
  if (key !== undefined && key.startsWith("-"))
    return unsupported(node, "unsupported defaults key");
  if (values.length > base + 3)
    return unsupported(node, "unsupported defaults form");
  if (target === "-g" || !target.includes("/")) return information(node);
  return pathEffects(node, [target], "read", "defaults");
}

function information(node: SyntaxNode): UnitSeed {
  return {
    kind: "command",
    text: node.text,
    situation: "workspace-neutral-or-indeterminate",
    allowed: true,
    reason: "defaults query",
  };
}
