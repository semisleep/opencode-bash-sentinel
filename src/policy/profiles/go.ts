import { looksLikePath, resolvePath, withinWorkspace } from "../paths";
import type { CommandProfile } from "../types";
import { dependencies } from "./helpers";

export const recognizeGoWorkflow: CommandProfile = (
  node,
  invocation,
  ctx,
  cwd,
) => {
  const args = invocation.args.map((argument) => argument.literal);
  let shape = args.every((argument) => argument !== undefined);
  const values = args as string[];
  if (values[0] === "mod")
    shape &&=
      ["download", "tidy"].includes(values[1] ?? "") && values.length === 2;
  else
    shape &&=
      ["build", "test", "vet", "fmt"].includes(values[0] ?? "") &&
      values.slice(1).every(
        (value) =>
          (!value.startsWith("-") || /^-[vx]$/.test(value)) &&
          (!looksLikePath(value) ||
            withinWorkspace(
              resolvePath(value, ctx, cwd) ?? "",
              ctx.workspace,
            )),
      );
  shape &&= withinWorkspace(cwd, ctx.workspace);
  return dependencies(
    node,
    ctx,
    cwd,
    ["go.mod", "?go.sum"],
    shape,
    "go workflow",
  );
};
