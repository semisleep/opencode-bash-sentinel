import type { SyntaxNode } from "../../parser/node";
import type { Effect, Invocation, UnitSeed } from "../types";
import { unsupported } from "./helpers";

const READERS = new Set([
  "cat",
  "ls",
  "head",
  "tail",
  "wc",
  "stat",
  "file",
  "readlink",
  "realpath",
  "du",
  "df",
  "diff",
  "cmp",
  "cut",
  "strings",
]);

const SHORT_OPTIONS: Record<string, string> = {
  cat: "AbEnstTuv",
  ls: "1AaBCFghHiklLmnpqQrRsStUvwX",
  head: "cnqvz",
  tail: "cfnqsvz",
  wc: "clmwL",
  stat: "cLfZ",
  file: "bEhiklLNnprsSvz",
  readlink: "efmnqsvz",
  realpath: "eLmqsz",
  du: "abchHkLmsSx",
  df: "ahHiPkPT",
  diff: "abBdiNqrsStTuwWy",
  cmp: "blnsi",
  cut: "bcdDfnsz",
  strings: "adelnstTx",
  rm: "dfiIrRv",
  rmdir: "pv",
  mkdir: "mpv",
  touch: "acmrt",
  truncate: "corsv",
  shred: "fnsvxz",
  tee: "ai",
  chmod: "cfRv",
  chown: "cfhRv",
  cp: "adfHilLnPrRuvx",
  mv: "finuv",
  ln: "dfinPrsv",
};

const LONG_OPTIONS: Record<string, Set<string>> = {
  cat: new Set([
    "--number",
    "--number-nonblank",
    "--show-all",
    "--show-ends",
    "--show-tabs",
    "--squeeze-blank",
  ]),
  ls: new Set([
    "--all",
    "--almost-all",
    "--classify",
    "--color",
    "--directory",
    "--human-readable",
    "--inode",
    "--long",
    "--recursive",
    "--reverse",
    "--size",
  ]),
  rm: new Set([
    "--dir",
    "--force",
    "--interactive",
    "--one-file-system",
    "--preserve-root",
    "--recursive",
    "--verbose",
  ]),
  rmdir: new Set(["--ignore-fail-on-non-empty", "--parents", "--verbose"]),
  mkdir: new Set(["--parents", "--verbose"]),
  touch: new Set(["--no-create"]),
  tee: new Set(["--append", "--ignore-interrupts"]),
  chmod: new Set([
    "--changes",
    "--recursive",
    "--quiet",
    "--silent",
    "--verbose",
  ]),
  chown: new Set([
    "--changes",
    "--recursive",
    "--quiet",
    "--silent",
    "--verbose",
  ]),
  cp: new Set([
    "--archive",
    "--force",
    "--interactive",
    "--link",
    "--no-clobber",
    "--recursive",
    "--reflink",
    "--symbolic-link",
    "--update",
    "--verbose",
  ]),
  mv: new Set([
    "--force",
    "--interactive",
    "--no-clobber",
    "--no-target-directory",
    "--update",
    "--verbose",
  ]),
  ln: new Set([
    "--force",
    "--interactive",
    "--no-dereference",
    "--no-target-directory",
    "--relative",
    "--symbolic",
    "--verbose",
  ]),
};

export function recognizeFilesystem(
  node: SyntaxNode,
  invocation: Invocation,
  name: string,
): UnitSeed | undefined {
  const args = invocation.args.map((argument) => argument.literal);
  if (args.some((argument) => argument === undefined))
    return unsupported(node, `dynamic ${name}`);
  const values = args as string[];
  if (READERS.has(name))
    return pathEffects(node, operands(values, name), "read", name);
  if (["rm", "rmdir"].includes(name)) {
    if (
      name === "rmdir" &&
      values.some(
        (value) =>
          value === "--parents" ||
          (value.startsWith("-") &&
            !value.startsWith("--") &&
            value.includes("p")),
      )
    )
      return unsupported(node, "rmdir parent removal");
    return pathEffects(node, operands(values, name), "delete", name);
  }
  if (["mkdir", "touch", "truncate", "shred", "tee"].includes(name))
    return pathEffects(node, operands(values, name), "write", name);
  if (["chmod", "chown"].includes(name)) {
    const items = operands(values, name);
    return pathEffects(
      node,
      items && items.length > 1 ? items.slice(1) : undefined,
      "write",
      name,
    );
  }
  if (["cp", "mv", "ln"].includes(name)) {
    const items = operands(values, name);
    if (!items || items.length < 2)
      return unsupported(node, `unsupported ${name}`);
    const sourceEffects = items.slice(0, -1).map(
      (item) =>
        ({
          kind: name === "mv" ? "move-source" : "read",
          path: item,
        }) as Effect,
    );
    return {
      kind: "command",
      text: node.text,
      effects: [
        sourceEffects[0]!,
        ...sourceEffects.slice(1),
        {
          kind: name === "mv" ? "move-destination" : "write",
          path: items.at(-1)!,
        },
      ],
      reason: name,
    };
  }
  return;
}

function operands(args: string[], name: string): string[] | undefined {
  const output: string[] = [];
  const short = SHORT_OPTIONS[name] ?? "";
  const long = LONG_OPTIONS[name] ?? new Set<string>();
  let options = true;
  for (const argument of args) {
    if (options && argument === "--") {
      options = false;
      continue;
    }
    if (options && argument.startsWith("--")) {
      const key = argument.split("=", 1)[0]!;
      if (!long.has(key) || argument.includes("=")) return;
      continue;
    }
    if (options && argument.startsWith("-") && argument !== "-") {
      if ([...argument.slice(1)].some((option) => !short.includes(option)))
        return;
      continue;
    }
    output.push(argument);
  }
  return output;
}

export function pathEffects(
  node: SyntaxNode,
  operands: string[] | undefined,
  kind: Effect["kind"],
  reason: string,
): UnitSeed {
  if (!operands) return unsupported(node, `unsupported ${reason}`);
  if (operands.length === 0)
    return {
      kind: "command",
      text: node.text,
      situation: "workspace-neutral-or-indeterminate",
      allowed: true,
      reason: `${reason} without path`,
    };
  return {
    kind: "command",
    text: node.text,
    effects: operands.map((path) => ({ kind, path })) as [Effect, ...Effect[]],
    reason,
  };
}
