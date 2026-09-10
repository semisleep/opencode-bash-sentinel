import path from "node:path";
import type { SyntaxNode } from "../../parser/node";
import type { UnitSeed, WorkspaceContext } from "../types";

export function unsupported(node: SyntaxNode, reason: string): UnitSeed {
  return {
    kind: "command",
    text: node.text,
    situation: "workspace-neutral-or-indeterminate",
    allowed: false,
    reason,
  };
}

export function dependencies(
  node: SyntaxNode,
  ctx: WorkspaceContext,
  cwd: string,
  files: string[],
  shape: boolean,
  reason: string,
) {
  const absolute: string[] = [];
  let allowed = shape;
  for (const item of files) {
    const optional = item.startsWith("?");
    const file = path.join(cwd, optional ? item.slice(1) : item);
    const status = ctx.baseline.status(file);
    if (optional && status === "absent") continue;
    absolute.push(file);
    if (status !== "clean") allowed = false;
  }
  return absoluteDependencies(node, ctx, absolute, allowed, reason);
}

export function absoluteDependencies(
  node: SyntaxNode,
  ctx: WorkspaceContext,
  files: string[],
  shape: boolean,
  reason: string,
): UnitSeed {
  const allowed =
    shape &&
    files.length > 0 &&
    files.every((file) => ctx.baseline.status(file) === "clean");
  return {
    kind: "command",
    text: node.text,
    situation: "workspace-neutral-or-indeterminate",
    allowed,
    reason: allowed ? reason : `${reason} requires clean committed files`,
    dependencies: files,
  };
}
