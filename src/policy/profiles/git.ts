import { resolvePath, withinWorkspace } from "../paths";
import type { CommandProfile } from "../types";

const READ_SUBCOMMANDS = new Set([
  "status",
  "diff",
  "log",
  "show",
  "blame",
  "rev-parse",
  "ls-files",
  "grep",
]);

const ALL_SUBCOMMANDS = new Set([
  ...READ_SUBCOMMANDS,
  "add",
  "commit",
  "fetch",
]);

const FLAGS: Record<string, Set<string>> = {
  status: new Set([
    "--short",
    "--branch",
    "--show-stash",
    "--ignored",
    "--no-renames",
  ]),
  diff: new Set([
    "--stat",
    "--name-only",
    "--name-status",
    "--cached",
    "--staged",
    "--quiet",
    "--exit-code",
    "--no-ext-diff",
    "--no-textconv",
  ]),
  log: new Set([
    "--oneline",
    "--stat",
    "--name-only",
    "--name-status",
    "--decorate",
    "--all",
    "--graph",
    "--no-merges",
  ]),
  show: new Set([
    "--stat",
    "--name-only",
    "--name-status",
    "--oneline",
    "--no-ext-diff",
    "--no-textconv",
  ]),
  blame: new Set([
    "--porcelain",
    "--line-porcelain",
    "--show-stats",
    "--reverse",
  ]),
  "rev-parse": new Set([
    "--verify",
    "--short",
    "--abbrev-ref",
    "--show-toplevel",
    "--show-prefix",
    "--is-inside-work-tree",
  ]),
  "ls-files": new Set([
    "--cached",
    "--deleted",
    "--modified",
    "--others",
    "--stage",
    "--unmerged",
    "--exclude-standard",
  ]),
  grep: new Set([
    "-n",
    "-i",
    "-I",
    "-w",
    "-F",
    "--line-number",
    "--ignore-case",
    "--word-regexp",
    "--fixed-strings",
  ]),
  add: new Set(["-A", "-u", "--all", "--update", "--intent-to-add"]),
};

export const recognizeGit: CommandProfile = (node, invocation, ctx, cwd) => {
  const args = invocation.args.map((argument) => argument.literal);
  if (args.some((argument) => argument === undefined))
    return rejected(node.text, "dynamic git");
  const values = args as string[];
  let index = 0;
  let repository = cwd;
  if (values[0] === "-C") {
    const resolved = values[1] && resolvePath(values[1], ctx, cwd);
    if (!resolved) return rejected(node.text, "unresolved git -C");
    repository = resolved;
    index = 2;
  }
  const subcommand = values[index];
  let allowed =
    !!subcommand &&
    ALL_SUBCOMMANDS.has(subcommand) &&
    validArguments(subcommand, values.slice(index + 1));
  if (
    !withinWorkspace(repository, ctx.workspace) &&
    !READ_SUBCOMMANDS.has(subcommand ?? "")
  )
    allowed = false;
  return {
    kind: "command",
    text: node.text,
    situation: "workspace-neutral-or-indeterminate",
    allowed,
    reason: allowed ? `git ${subcommand}` : "unsupported git form",
  };
};

function rejected(text: string, reason: string) {
  return {
    kind: "command" as const,
    text,
    situation: "workspace-neutral-or-indeterminate" as const,
    allowed: false,
    reason,
  };
}

function validArguments(subcommand: string, args: string[]) {
  if (subcommand === "commit") return commitArguments(args);
  if (subcommand === "fetch") return fetchArguments(args);
  const allowed = FLAGS[subcommand];
  if (!allowed) return false;
  return args.every(
    (argument) =>
      !argument.startsWith("-") ||
      allowed.has(argument) ||
      ((subcommand === "log" || subcommand === "show") &&
        (/^-\d+$/.test(argument) || argument.startsWith("--max-count="))) ||
      (subcommand === "status" && argument.startsWith("--untracked-files=")),
  );
}

function commitArguments(args: string[]) {
  for (let index = 0; index < args.length; index++) {
    if (["-m", "--message"].includes(args[index]!)) {
      if (!args[++index]) return false;
    } else if (
      !args[index]!.startsWith("--message=") &&
      ![
        "-a",
        "--all",
        "--amend",
        "--no-edit",
        "--allow-empty",
        "--quiet",
      ].includes(args[index]!)
    )
      return false;
  }
  return true;
}

function fetchArguments(args: string[]) {
  const flags = new Set([
    "--all",
    "--prune",
    "--tags",
    "--quiet",
    "--verbose",
  ]);
  const operands: string[] = [];
  for (const argument of args) {
    if (argument.startsWith("-")) {
      if (!flags.has(argument)) return false;
    } else operands.push(argument);
  }
  if (args.includes("--all") && operands.length > 0) return false;
  if (operands.length === 0) return true;
  if (!safeRemote(operands[0]!)) return false;
  return operands.slice(1).every(safeRefspec);
}

function safeRemote(remote: string) {
  if (!remote || /[\s\0]/.test(remote) || remote.includes("::")) return false;
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(remote)?.[1];
  if (
    scheme &&
    !["http", "https", "ssh", "git", "file"].includes(scheme.toLowerCase())
  )
    return false;
  return !remote.startsWith("-");
}

function safeRefspec(refspec: string) {
  return /^\+?[A-Za-z0-9._/-]+(?::[A-Za-z0-9._/-]*)?$/.test(refspec);
}
