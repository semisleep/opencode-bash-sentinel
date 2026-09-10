import type { SyntaxNode } from "../../parser/node";
import { looksLikePath, resolvePath, withinWorkspace } from "../paths";
import type { Invocation, UnitSeed, Word, WorkspaceContext } from "../types";
import { unsupported } from "./helpers";

export const INTERPRETER_NAMES = new Set([
  "bash",
  "sh",
  "zsh",
  "dash",
  "python",
  "python3",
  "node",
  "ruby",
  "perl",
  "php",
]);

export function recognizeInterpreter(
  node: SyntaxNode,
  invocation: Invocation,
  ctx: WorkspaceContext,
  cwd: string,
  name: string,
): UnitSeed {
  let index = 0;
  if (!["source", "."].includes(name) && invocation.args[0]?.literal === "--")
    index = 1;
  const entry = invocation.args[index];
  if (!entry?.literal || entry.literal === "-" || entry.literal.startsWith("-"))
    return unsupported(node, "unsupported interpreter or inline program");
  return recognizeScript(node, invocation, ctx, cwd, entry, index + 1);
}

export function recognizeScript(
  node: SyntaxNode,
  invocation: Invocation,
  ctx: WorkspaceContext,
  cwd: string,
  entry: Word,
  argumentStart: number,
): UnitSeed {
  if (!entry.literal) return unsupported(node, "dynamic script entry");
  const file = resolvePath(entry.literal, ctx, cwd);
  if (!file) return unsupported(node, "unresolved script entry");
  const inside = withinWorkspace(file, ctx.workspace);
  const badArgument = invocation.args
    .slice(argumentStart)
    .some(
      (argument) =>
        argument.literal === undefined ||
        (looksLikePath(argument.literal) &&
          !withinWorkspace(
            resolvePath(argument.literal, ctx, cwd) ?? "",
            ctx.workspace,
          )),
    );
  const allowed =
    inside && ctx.baseline.status(file) === "clean" && !badArgument;
  return {
    kind: "command",
    text: node.text,
    effects: [{ kind: "read", path: entry.literal }],
    allowed,
    reason: allowed
      ? "trusted workspace script"
      : "workspace script red line or external script",
    dependencies: inside ? [file] : [],
  };
}
