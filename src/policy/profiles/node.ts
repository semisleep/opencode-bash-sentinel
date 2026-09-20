import type { SyntaxNode } from "../../parser/node";
import { withinWorkspace } from "../paths";
import type { CommandProfile, UnitSeed, WorkspaceContext } from "../types";
import {
  dependencies,
  unsupported,
  unsafeVisibleArgument,
} from "./helpers";

export const NODE_WORKFLOW_NAMES = new Set(["npm", "pnpm", "yarn", "bun"]);

export const recognizeNodeWorkflow: CommandProfile = (
  node,
  invocation,
  ctx,
  cwd,
  name,
) => {
  const args = invocation.args.map((argument) => argument.literal);
  if (args.every((argument) => argument !== undefined)) {
    const listing = recognizeDependencyList(
      node,
      args as string[],
      name,
    );
    if (listing) return listing;
  }
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

// `npm ls` / `pnpm ls` / `yarn list` print the dependency tree without
// running lifecycle scripts or touching files, so the form allows as pure
// information regardless of the workflow baseline that gates npm
// test/run. Flags are a closed display-only set (-g/--global, --json,
// attached --depth=N); remaining operands are literal package names
// (data, not paths). Every other flag or a dynamic operand falls back to
// the fail-closed workflow path.
function recognizeDependencyList(
  node: SyntaxNode,
  args: string[],
  name: string,
): UnitSeed | undefined {
  const subcommand = args[0];
  const heads = name === "yarn" ? ["list"] : ["ls", "list"];
  if (!heads.includes(subcommand ?? "")) return undefined;
  for (const value of args.slice(1)) {
    if (value === "-g" || value === "--global" || value === "--json")
      continue;
    if (/^--depth=\d+$/.test(value)) continue;
    if (value.startsWith("-"))
      return unsupported(node, `unsupported ${name} list option`);
  }
  return {
    kind: "command",
    text: node.text,
    situation: "workspace-neutral-or-indeterminate",
    allowed: true,
    reason: `${name} dependency listing`,
  };
}

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
