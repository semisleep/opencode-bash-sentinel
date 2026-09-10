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
  const subcommand = args[0];
  const tail = args.slice(1) as string[];
  const shape =
    withinWorkspace(cwd, ctx.workspace) &&
    args.every((argument) => argument !== undefined) &&
    SUBCOMMANDS.has(subcommand ?? "") &&
    validArguments(subcommand!, tail);
  return dependencies(
    node,
    ctx,
    cwd,
    ["Cargo.toml", "?Cargo.lock"],
    shape,
    "cargo workflow",
  );
};

function validArguments(subcommand: string, args: string[]) {
  const operands = args.filter((argument) => !argument.startsWith("-"));
  return (
    args.every(
      (argument) => !argument.startsWith("-") || /^-[vx]$/.test(argument),
    ) &&
    (subcommand === "test" ? operands.length <= 1 : operands.length === 0)
  );
}
