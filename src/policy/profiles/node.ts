import { withinWorkspace } from "../paths";
import type { CommandProfile, WorkspaceContext } from "../types";
import { dependencies, unsafeVisibleArgument } from "./helpers";

export const NODE_WORKFLOW_NAMES = new Set(["npm", "pnpm", "yarn", "bun"]);

export const recognizeNodeWorkflow: CommandProfile = (
  node,
  invocation,
  ctx,
  cwd,
  name,
) => {
  const args = invocation.args.map((argument) => argument.literal);
  let shape =
    withinWorkspace(cwd, ctx.workspace) &&
    args.every((argument) => argument !== undefined) &&
    (name === "npm"
      ? args[0] === "test" ||
        (args[0] === "run" && !!args[1] && !args[1]!.startsWith("-"))
      : args[0] === "run" && !!args[1] && !args[1]!.startsWith("-"));
  if (shape) shape = validTail(args as string[], name, ctx, cwd);
  return dependencies(
    node,
    ctx,
    cwd,
    ["package.json"],
    shape,
    `${name} workflow`,
  );
};

function validTail(
  args: string[],
  name: string,
  ctx: WorkspaceContext,
  cwd: string,
) {
  const start = name === "npm" && args[0] === "test" ? 1 : 2;
  const tail = args.slice(start);
  // Everything after `--` is forwarded verbatim to the trusted script, so it
  // must pass the same visible-argument screening as a direct invocation.
  return (
    tail.length === 0 ||
    (tail[0] === "--" &&
      tail
        .slice(1)
        .every((argument) => !unsafeVisibleArgument(argument, ctx, cwd)))
  );
}
