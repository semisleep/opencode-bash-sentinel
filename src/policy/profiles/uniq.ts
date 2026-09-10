import type { SyntaxNode } from "../../parser/node";
import type { Effect, Invocation, UnitSeed } from "../types";
import { unsupported } from "./helpers";

export function recognizeUniq(
  node: SyntaxNode,
  invocation: Invocation,
): UnitSeed {
  const args = invocation.args.map((argument) => argument.literal);
  if (args.some((argument) => argument === undefined))
    return unsupported(node, "dynamic uniq");
  const items: string[] = [];
  let options = true;
  const values = args as string[];
  for (let index = 0; index < values.length; index++) {
    const value = values[index]!;
    if (options && value === "--") {
      options = false;
      continue;
    }
    if (
      options &&
      [
        "-f",
        "--skip-fields",
        "-s",
        "--skip-chars",
        "-w",
        "--check-chars",
      ].includes(value)
    ) {
      if (!/^\d+$/.test(values[++index] ?? ""))
        return unsupported(node, "unsupported uniq option value");
      continue;
    }
    if (options && value.startsWith("--")) {
      if (
        ![
          "--count",
          "--repeated",
          "--ignore-case",
          "--unique",
          "--zero-terminated",
        ].includes(value)
      )
        return unsupported(node, "unsupported uniq option");
      continue;
    }
    if (options && value.startsWith("-") && value !== "-") {
      if ([...value.slice(1)].some((option) => !"cdiuz".includes(option)))
        return unsupported(node, "unsupported uniq option");
      continue;
    }
    items.push(value);
  }
  if (items.length > 2) return unsupported(node, "unsupported uniq operands");
  if (items.length === 0)
    return {
      kind: "command",
      text: node.text,
      situation: "workspace-neutral-or-indeterminate",
      allowed: true,
      reason: "uniq stdin",
    };
  return {
    kind: "command",
    text: node.text,
    effects: [
      { kind: "read", path: items[0]! },
      ...(items[1] ? [{ kind: "write" as const, path: items[1] }] : []),
    ] as [Effect, ...Effect[]],
    reason: "uniq",
  };
}
