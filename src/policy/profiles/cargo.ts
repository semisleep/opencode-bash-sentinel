import { withinWorkspace } from "../paths";
import type { CommandProfile } from "../types";
import { dependencies } from "./helpers";

const SUBCOMMANDS = new Set(["build", "test", "check", "fmt", "clippy"]);

export const recognizeCargoWorkflow: CommandProfile = (
  node,
  invocation,
  ctx,
  cwd,
) => {
  const args = invocation.args.map((argument) => argument.literal);
  const shape =
    withinWorkspace(cwd, ctx.workspace) &&
    args.every((argument) => argument !== undefined) &&
    SUBCOMMANDS.has(args[0] ?? "") &&
    (args.slice(1) as string[]).every(
      (argument) => !argument.startsWith("-") || /^-[vx]$/.test(argument),
    );
  return dependencies(
    node,
    ctx,
    cwd,
    ["Cargo.toml", "?Cargo.lock"],
    shape,
    "cargo workflow",
  );
};
