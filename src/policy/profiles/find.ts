import type { SyntaxNode } from "../../parser/node";
import type { Effect, Invocation, UnitSeed } from "../types";
import { unsupported } from "./helpers";

const SYMLINK_OPTIONS = new Set(["-H", "-L", "-P"]);

const TESTS = new Set([
  "-daystart",
  "-depth",
  "-empty",
  "-false",
  "-follow",
  "-ignore_readdir_race",
  "-ls",
  "-mount",
  "-noleaf",
  "-noignore_readdir_race",
  "-print",
  "-print0",
  "-prune",
  "-true",
  "-xdev",
]);

// Value operands are patterns, counts, ids, or formats, not classification
// targets; -newer's reference file is handled separately as a read.
const TESTS_WITH_VALUE = new Set([
  "-amin",
  "-atime",
  "-cmin",
  "-ctime",
  "-gid",
  "-group",
  "-iname",
  "-inum",
  "-ipath",
  "-iregex",
  "-ilname",
  "-links",
  "-lname",
  "-maxdepth",
  "-mindepth",
  "-mmin",
  "-mtime",
  "-name",
  "-path",
  "-perm",
  "-printf",
  "-regex",
  "-regextype",
  "-size",
  "-type",
  "-uid",
  "-user",
  "-xtype",
]);

const OPERATORS = new Set(["!", "-not", "-a", "-and", "-o", "-or", "(", ")"]);

/** Situation-1/2 read profile: directory traversal without side effects. */
export function recognizeFind(
  node: SyntaxNode,
  invocation: Invocation,
): UnitSeed {
  const args = invocation.args.map((argument) => argument.literal);
  if (args.some((argument) => argument === undefined))
    return unsupported(node, "dynamic find");
  const values = args as string[];

  let index = 0;
  while (index < values.length && SYMLINK_OPTIONS.has(values[index]!)) index++;
  const paths: string[] = [];
  while (
    index < values.length &&
    !values[index]!.startsWith("-") &&
    !OPERATORS.has(values[index]!)
  ) {
    paths.push(values[index]!);
    index++;
  }
  const references: string[] = [];
  while (index < values.length) {
    const token = values[index]!;
    if (TESTS.has(token) || OPERATORS.has(token)) {
      index++;
      continue;
    }
    if (token === "-newer") {
      const file = values[++index];
      if (!file) return unsupported(node, "missing find -newer reference");
      references.push(file);
      index++;
      continue;
    }
    if (TESTS_WITH_VALUE.has(token)) {
      if (!values[++index]) return unsupported(node, "missing find primary value");
      index++;
      continue;
    }
    // Everything else fails closed; that bucket includes the destructive
    // primaries (-delete, -exec, -execdir, -ok, -okdir), file-writing
    // primaries (-fprint, -fprint0, -fprintf, -fls), and -newerXY variants.
    return unsupported(node, "unsupported find primary");
  }

  const effects = [...(paths.length > 0 ? paths : ["."]), ...references];
  return {
    kind: "command",
    text: node.text,
    effects: effects.map((path): Effect => ({ kind: "read", path })) as [
      Effect,
      ...Effect[],
    ],
    reason: "find",
  };
}
