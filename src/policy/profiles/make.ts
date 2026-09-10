import path from "node:path";
import { resolvePath, withinWorkspace } from "../paths";
import type { CommandProfile } from "../types";
import { absoluteDependencies, unsupported } from "./helpers";

export const recognizeMakeWorkflow: CommandProfile = (
  node,
  invocation,
  ctx,
  cwd,
) => {
  const args = invocation.args.map((argument) => argument.literal);
  if (args.some((argument) => argument === undefined))
    return unsupported(node, "dynamic make");
  const values = args as string[];
  let selected: string | undefined;
  let shape = true;
  for (let index = 0; index < values.length; index++) {
    const argument = values[index]!;
    if (argument === "-f" || argument === "--file") {
      selected = values[++index];
      if (!selected) shape = false;
      continue;
    }
    if (/^-j\d+$/.test(argument) || /^--jobs=\d+$/.test(argument)) continue;
    if (argument === "-j" || argument === "--jobs") {
      if (!/^\d+$/.test(values[++index] ?? "")) shape = false;
      continue;
    }
    if (argument.startsWith("-") || argument.includes("=")) shape = false;
  }
  let file = selected && resolvePath(selected, ctx, cwd);
  if (!file)
    file = ["GNUmakefile", "Makefile"]
      .map((name) => path.join(cwd, name))
      .find((candidate) => ctx.baseline.status(candidate) !== "absent");
  if (!file || !withinWorkspace(file, ctx.workspace))
    return unsupported(node, "missing or external Makefile");
  return absoluteDependencies(node, ctx, [file], shape, "make workflow");
};
