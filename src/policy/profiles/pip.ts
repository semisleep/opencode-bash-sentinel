import path from "node:path";
import type { SyntaxNode } from "../../parser/node";
import { resolvePath, withinWorkspace } from "../paths";
import type { Invocation, UnitSeed, WorkspaceContext } from "../types";
import { absoluteDependencies, unsupported } from "./helpers";

export function recognizePip(
  node: SyntaxNode,
  invocation: Invocation,
  ctx: WorkspaceContext,
  cwd: string,
  argumentStart = 0,
): UnitSeed {
  const args = invocation.args
    .slice(argumentStart)
    .map((argument) => argument.literal);
  if (args.some((argument) => argument === undefined))
    return unsupported(node, "dynamic pip");
  const values = args as string[];
  if (values[0] === "show")
    return {
      kind: "command",
      text: node.text,
      situation: "workspace-neutral-or-indeterminate",
      allowed:
        values.length > 1 &&
        values.slice(1).every((value) => !value.startsWith("-")),
      reason: "pip information",
    };
  if (["list", "check", "freeze"].includes(values[0] ?? ""))
    return {
      kind: "command",
      text: node.text,
      situation: "workspace-neutral-or-indeterminate",
      allowed: values.length === 1,
      reason: "pip information",
    };
  if (
    values[0] === "install" &&
    values[1] === "-r" &&
    values.length === 3
  ) {
    const file = resolvePath(values[2]!, ctx, cwd);
    return file && withinWorkspace(file, ctx.workspace)
      ? absoluteDependencies(node, ctx, [file], true, "pip requirements")
      : unsupported(node, "external requirements");
  }
  if (values.join(" ") === "install .") {
    const files = ["pyproject.toml", "setup.cfg", "setup.py"]
      .map((name) => path.join(cwd, name))
      .filter((file) => ctx.baseline.status(file) !== "absent");
    return absoluteDependencies(
      node,
      ctx,
      files,
      withinWorkspace(cwd, ctx.workspace) && files.length > 0,
      "pip local install",
    );
  }
  return unsupported(node, "unsupported pip");
}
