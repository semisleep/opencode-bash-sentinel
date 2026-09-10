import path from "node:path";
import type { SyntaxNode } from "../parser/node";
import { literal } from "./normalize";
import type { UnitSeed } from "./types";

export function recognizeRedirect(node: SyntaxNode): UnitSeed {
  const operator = node.children.find((child) => !child.isNamed)?.text;
  const target = node.children.find(
    (child) => child.isNamed && child.type !== "file_descriptor",
  );
  if (!operator || !target) return rejected(node, "unresolved redirect");
  if (
    [">&", "<&"].includes(operator) &&
    (target.type === "number" || target.text === "-")
  )
    return {
      kind: "redirect",
      text: node.text,
      situation: "workspace-neutral-or-indeterminate",
      allowed: true,
      reason: "fd redirect",
    };
  const value = literal(target);
  if (!value) return rejected(node, "dynamic redirect");
  if (isSpecialBashPath(value))
    return rejected(node, "special Bash redirect path");
  if (value === "/dev/null")
    return {
      kind: "redirect",
      text: node.text,
      situation: "workspace-neutral-or-indeterminate",
      allowed: true,
      reason: "/dev/null",
    };
  const writes = [">", ">>", "&>", "&>>", ">|", "<>"].includes(operator);
  if (!writes && operator !== "<")
    return rejected(node, "unsupported redirect");
  return {
    kind: "redirect",
    text: node.text,
    effects: [{ kind: writes ? "write" : "read", path: value }],
    reason: "file redirect",
  };
}

function rejected(node: SyntaxNode, reason: string): UnitSeed {
  return {
    kind: "redirect",
    text: node.text,
    situation: "workspace-neutral-or-indeterminate",
    allowed: false,
    reason,
  };
}

function isSpecialBashPath(value: string) {
  const normalized = path.posix.normalize(value.replaceAll("\\", "/"));
  return ["/dev/tcp", "/dev/udp", "/dev/fd", "/proc/self/fd"].some(
    (root) => normalized === root || normalized.startsWith(`${root}/`),
  );
}
