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
  "uniq",
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
  uniq: "cdfisuwz",
  rm: "dfiIrRv",
  rmdir: "pv",
  mkdir: "mpv",
  touch: "acmrt",
  truncate: "corsv",
  shred: "fnsvxz",
  tee: "ai",
  chmod: "cfRv",
  chown: "cfhRv",
  cp: "abdfHilLnPrRsSuvx",
  mv: "bfinSuv",
  ln: "bdfinPrsSv",
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
  if (READERS.has(name)) return pathEffects(node, operands(values, name), "read", name);
  if (["rm", "rmdir"].includes(name))
    return pathEffects(node, operands(values, name), "delete", name);
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
    return {
      kind: "command",
      text: node.text,
      effects: [
        ...items.slice(0, -1).map(
          (item) =>
            ({
              kind: name === "mv" ? "move-source" : "read",
              path: item,
            }) as Effect,
        ),
        {
          kind: name === "mv" ? "move-destination" : "write",
          path: items.at(-1)!,
        },
      ],
      reason: name,
    };
  }
  if (["rg", "ripgrep", "grep"].includes(name))
    return recognizeSearch(node, values, name);
  if (name === "dd") return recognizeDd(node, values);
  return;
}

function recognizeDd(node: SyntaxNode, args: string[]): UnitSeed {
  const effects: Effect[] = [];
  for (const argument of args) {
    if (argument.startsWith("if="))
      effects.push({ kind: "read", path: argument.slice(3) });
    else if (argument.startsWith("of="))
      effects.push({ kind: "write", path: argument.slice(3) });
    else if (!/^[a-z_]+=[^=]+$/i.test(argument))
      return unsupported(node, "unsupported dd");
  }
  return effects.length
    ? { kind: "command", text: node.text, effects, reason: "dd" }
    : unsupported(node, "dd without path");
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

function recognizeSearch(
  node: SyntaxNode,
  args: string[],
  name: string,
): UnitSeed {
  const paths: string[] = [];
  let hasPattern = false;
  for (let index = 0; index < args.length; index++) {
    const value = args[index]!;
    if (value === "--") {
      if (!hasPattern) {
        if (!args[index + 1])
          return unsupported(node, `missing ${name} pattern`);
        hasPattern = true;
        index++;
      }
      paths.push(...args.slice(index + 1));
      break;
    }
    if (!hasPattern && value.startsWith("-")) {
      if (["-e", "--regexp", "-g", "--glob", "-t", "--type"].includes(value)) {
        if (!args[++index])
          return unsupported(node, `missing ${name} option value`);
        if (value === "-e" || value === "--regexp") hasPattern = true;
        continue;
      }
      if (
        !/^-[nHhIiSsUvVwcClLo]+$/.test(value) &&
        ![
          "--hidden",
          "--follow",
          "--files",
          "--count",
          "--line-number",
          "--no-heading",
          "--fixed-strings",
        ].includes(value)
      )
        return unsupported(node, `unsupported ${name} option`);
      continue;
    }
    if (!hasPattern) hasPattern = true;
    else paths.push(value);
  }
  if (!hasPattern) return unsupported(node, `missing ${name} pattern`);
  return paths.length
    ? pathEffects(node, paths, "read", name)
    : {
        kind: "command",
        text: node.text,
        situation: "workspace-neutral-or-indeterminate",
        allowed: true,
        reason: `${name} cwd search`,
      };
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
    effects: operands.map((path) => ({ kind, path })),
    reason,
  };
}
