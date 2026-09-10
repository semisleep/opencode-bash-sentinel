import path from "node:path";
import type { SyntaxNode } from "../parser/node";
import type {
  Effect,
  UnitSeed,
  WorkspaceContext,
} from "./types";

export function unsupported(node: SyntaxNode, reason: string): UnitSeed {
  return {
    kind: "command",
    text: node.text,
    situation: "workspace-neutral-or-indeterminate",
    allowed: false,
    reason,
  };
}

export function pathSeed(
  node: SyntaxNode,
  operands: string[] | undefined,
  kind: Effect["kind"],
  reason: string,
): UnitSeed {
  return operands
    ? operands.length
      ? {
          kind: "command",
          text: node.text,
          effects: operands.map((path) => ({ kind, path })),
          reason,
        }
      : {
          kind: "command",
          text: node.text,
          situation: "workspace-neutral-or-indeterminate",
          allowed: true,
          reason: `${reason} without path`,
        }
    : unsupported(node, `unsupported ${reason}`);
}

export function dependencySeed(
  node: SyntaxNode,
  ctx: WorkspaceContext,
  files: string[],
  shape: boolean,
  reason: string,
): UnitSeed {
  const ok =
    shape &&
    files.length > 0 &&
    files.every((file) => ctx.baseline.status(file) === "clean");
  return {
    kind: "command",
    text: node.text,
    situation: "workspace-neutral-or-indeterminate",
    allowed: ok,
    reason: ok ? reason : `${reason} requires clean committed files`,
    dependencies: files,
  };
}

export function workspaceDependencies(
  node: SyntaxNode,
  ctx: WorkspaceContext,
  cwd: string,
  files: string[],
  shape: boolean,
  reason: string,
) {
  const absolute: string[] = [];
  let ok = shape;
  for (const item of files) {
    const optional = item.startsWith("?");
    const file = path.join(cwd, optional ? item.slice(1) : item);
    const status = ctx.baseline.status(file);
    if (optional && status === "absent") continue;
    absolute.push(file);
    if (status !== "clean") ok = false;
  }
  return dependencySeed(node, ctx, absolute, ok, reason);
}
