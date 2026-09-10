import type { SyntaxNode } from "../../../parser/node";
import type { Invocation, UnitSeed } from "../../types";
import { pathEffects, unsupported } from "../helpers";
import { literalArguments, parseArguments } from "./options";

const NAMES = new Set(["rm", "rmdir"]);

export function recognizeFilesystemRemoval(
  node: SyntaxNode,
  invocation: Invocation,
  name: string,
): UnitSeed | undefined {
  if (!NAMES.has(name)) return;
  const args = literalArguments(invocation);
  if (!args) return unsupported(node, `dynamic ${name}`);
  if (
    name === "rmdir" &&
    args.some(
      (value) =>
        value === "--parents" ||
        (value.startsWith("-") &&
          !value.startsWith("--") &&
          value.includes("p")),
    )
  )
    return unsupported(node, "rmdir parent removal");
  const parsed = parseArguments(
    args,
    name === "rm"
      ? {
          short: "dfiIrRv",
          long: new Set([
            "--dir",
            "--force",
            "--interactive",
            "--one-file-system",
            "--preserve-root",
            "--recursive",
            "--verbose",
          ]),
        }
      : {
          short: "v",
          long: new Set(["--ignore-fail-on-non-empty", "--verbose"]),
      },
  );
  if (parsed?.operands.length === 0)
    return unsupported(node, `missing ${name} operand`);
  return pathEffects(node, parsed?.operands, "delete", name);
}
