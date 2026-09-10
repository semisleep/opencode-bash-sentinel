import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { parse } from "./parser/index";
import type { SyntaxNode } from "./parser/node";

export type Situation =
  | "workspace-inside"
  | "workspace-outside"
  | "workspace-neutral-or-indeterminate";
export type BaselineStatus = "clean" | "dirty" | "absent" | "unknown";
export interface BaselineInspector {
  status(file: string): BaselineStatus;
}
export interface WorkspaceContext {
  readonly workspace: string;
  /** Initial OpenCode session directory used to resolve relative paths. */
  readonly cwd: string;
  readonly homedir: string;
  readonly baseline: BaselineInspector;
}
export interface DecisionUnit {
  readonly kind: "command" | "redirect" | "assignment";
  readonly text: string;
  readonly situation?: Situation;
  readonly action: "allow" | "ask";
  readonly reason: string;
  readonly mutationScopes: readonly string[];
  readonly stabilityDependencies: readonly string[];
}
export interface PolicyResult {
  readonly action: "allow" | "ask";
  readonly reason: string;
  readonly units: readonly DecisionUnit[];
}
type Effect = {
  kind: "read" | "write" | "delete" | "move-source" | "move-destination";
  path: string;
};
type Seed = {
  kind: DecisionUnit["kind"];
  text: string;
  effects?: Effect[];
  situation?: Situation;
  allowed?: boolean;
  reason: string;
  dependencies?: string[];
};
type Word = { raw: string; literal?: string };
type Invocation = { executable: Word; args: Word[]; assignments: string[] };

const STRUCTURAL_DENY = new Set([
  "ERROR",
  "if_statement",
  "elif_clause",
  "else_clause",
  "while_statement",
  "until_statement",
  "for_statement",
  "c_style_for_statement",
  "case_statement",
  "case_item",
  "function_definition",
  "subshell",
  "compound_statement",
  "process_substitution",
  "herestring_redirect",
  "heredoc_redirect",
  "negated_command",
  "test_command",
  "unset_command",
]);
const RISKY_ENV = new Set([
  "PATH",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "BASH_ENV",
  "ENV",
  "ZDOTDIR",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "HOME",
  "CDPATH",
  "NODE_OPTIONS",
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "RUBYOPT",
  "RUBYLIB",
  "PERL5OPT",
]);
const INTERPRETERS = new Set([
  "bash",
  "sh",
  "zsh",
  "dash",
  "python",
  "python3",
  "node",
  "ruby",
  "perl",
  "php",
]);
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
const INFO: Record<string, RegExp> = {
  date: /^$/,
  uname: /^(?: -(?:[asnrvmpio]+))*$/,
  uptime: /^$/,
  whoami: /^$/,
  id: /^(?: -(?:[ugGnr]+))*$/,
  free: /^(?: -(?:[bkmghwtsc]+))*$/,
  vm_stat: /^$/,
  nproc: /^(?: --(?:all|ignore)(?: \d+)?)?$/,
  lscpu: /^(?: -[abcepJ])*$/,
  ps: /^(?: (?:aux|[aux]|-[aefx]))*$/,
  pwd: /^(?: -[LP])?$/,
  true: /^$/,
  false: /^$/,
  ":": /^$/,
};
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
const GIT_READ = new Set([
  "status",
  "diff",
  "log",
  "show",
  "blame",
  "rev-parse",
  "ls-files",
  "grep",
]);
const GIT_ALL = new Set([...GIT_READ, "add", "commit", "fetch"]);

const CONSUMED_NAMED_NODES = new Set([
  "program",
  "list",
  "pipeline",
  "redirected_statement",
  "command",
  "command_name",
  "word",
  "raw_string",
  "ansi_c_string",
  "string",
  "string_content",
  "concatenation",
  "command_substitution",
  "variable_assignment",
  "variable_name",
  "declaration_command",
  "file_redirect",
  "file_descriptor",
  "number",
  "simple_expansion",
  "expansion",
  "comment",
]);

export function analyzeWorkspacePolicy(
  source: string,
  ctx: WorkspaceContext,
): PolicyResult {
  try {
    const parsed = parse(source, { timeoutMs: 500, maxNodes: 10_000 });
    if (!parsed.ok) return denied("parser resource budget exceeded");
    if (parsed.hasError) return denied("Bash parse failed");
    const structural = validate(parsed.rootNode);
    if (structural) return denied(structural);
    const commands = collect(parsed.rootNode, "command");
    if (
      commands.some(
        (n) =>
          invocation(n)?.executable.literal === "cd" &&
          ancestor(n, "command_substitution"),
      )
    )
      return denied("unsupported nested cwd transition");
    const direct = commands.filter((n) => !ancestor(n, "command_substitution"));
    const cwdMap = cwds(direct, ctx);
    if (cwdMap.reason) return denied(cwdMap.reason);
    const units: DecisionUnit[] = [];
    for (const n of collect(parsed.rootNode, "variable_assignment").filter(
      (n) => !ancestor(n, "command") && !ancestor(n, "declaration_command"),
    ))
      units.push(finish(assignment(n), ctx, ctx.cwd));
    for (const n of collect(parsed.rootNode, "declaration_command"))
      units.push(finish(declaration(n), ctx, ctx.cwd));
    for (const n of commands) {
      const cwd = cwdAt(n, cwdMap.map, ctx.cwd);
      units.push(finish(command(n, ctx, cwd), ctx, cwd));
    }
    for (const n of collect(parsed.rootNode, "file_redirect")) {
      const cwd = cwdAt(n, cwdMap.map, ctx.cwd);
      units.push(finish(redirect(n), ctx, cwd));
    }
    const bad = units.find((u) => u.action === "ask");
    if (bad) return { action: "ask", reason: bad.reason, units };
    const mutations = units.flatMap((u) => u.mutationScopes),
      deps = units.flatMap((u) => u.stabilityDependencies);
    if (mutations.some((m) => deps.some((d) => overlap(m, d))))
      return {
        action: "ask",
        reason: "mutation overlaps stability dependency",
        units,
      };
    if (units.length === 0) return denied("no supported decision units");
    return { action: "allow", reason: "all decision units allow", units };
  } catch {
    return denied("policy engine failure");
  }
}
function denied(reason: string): PolicyResult {
  return { action: "ask", reason, units: [] };
}
function validate(root: SyntaxNode): string | undefined {
  const stack = [root];
  while (stack.length) {
    const n = stack.pop()!;
    if (STRUCTURAL_DENY.has(n.type))
      return `unsupported Bash structure: ${n.type}`;
    if (n.isNamed && !CONSUMED_NAMED_NODES.has(n.type))
      return `unconsumed Bash node: ${n.type}`;
    if (n.type === "arithmetic_expansion")
      return "unsupported Bash expansion: arithmetic_expansion";
    if (n.type === "simple_expansion" && !pureSimpleExpansion(n.text))
      return "unsupported Bash expansion: simple_expansion";
    if (n.type === "expansion" && !/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(n.text))
      return "unsupported Bash expansion: expansion";
    if (n.type === "word" && /(^|[^\\])[{}]/.test(n.text))
      return "unsupported Bash expansion: brace expansion";
    if (!n.isNamed && (n.text === "&" || n.text === "|&"))
      return `unsupported Bash operator: ${n.text}`;
    stack.push(...n.children);
  }
}
function pureSimpleExpansion(text: string) {
  return /^\$(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]+|[?#$!@*_-])$/.test(text);
}
function collect(root: SyntaxNode, type: string) {
  const out: SyntaxNode[] = [],
    stack = [root];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.type === type) out.push(n);
    for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]!);
  }
  return out;
}
function ancestor(n: SyntaxNode, type: string) {
  for (let p = n.parent; p; p = p.parent) if (p.type === type) return true;
  return false;
}
function envName(n: SyntaxNode) {
  return n.children.find((c) => c.type === "variable_name")?.text;
}
function risky(name: string) {
  return RISKY_ENV.has(name) || name.startsWith("DYLD_");
}
function assignment(n: SyntaxNode): Seed {
  const name = envName(n);
  const ok = !!name && !risky(name);
  return {
    kind: "assignment",
    text: n.text,
    situation: "workspace-neutral-or-indeterminate",
    allowed: ok,
    reason: ok ? "ordinary assignment" : "high-risk assignment",
  };
}
function declaration(n: SyntaxNode): Seed {
  const keyword = n.children.find((c) => !c.isNamed)?.text,
    vars = n.children.filter((c) => c.type === "variable_assignment");
  const ok =
    !!keyword &&
    ["export", "declare", "typeset", "readonly"].includes(keyword) &&
    vars.length > 0 &&
    n.namedChildren.length === vars.length &&
    vars.every((v) => {
      const x = envName(v);
      return !!x && !risky(x);
    });
  return {
    kind: "assignment",
    text: n.text,
    situation: "workspace-neutral-or-indeterminate",
    allowed: ok,
    reason: ok
      ? "recognized declaration"
      : "unsupported or high-risk declaration",
  };
}
function literal(n: SyntaxNode): string | undefined {
  if (n.type === "number") return n.text;
  if (n.type === "word")
    return /[$`*?[\]{}()]/.test(n.text)
      ? undefined
      : n.text.replaceAll(/\\(.)/gs, "$1");
  if (n.type === "raw_string" || n.type === "ansi_c_string")
    return n.text.slice(1, -1);
  if (n.type === "string" || n.type === "concatenation") {
    let s = "";
    for (const c of n.children) {
      if (!c.isNamed) continue;
      if (c.type === "string_content") s += c.text;
      else {
        const v = literal(c);
        if (v === undefined) return;
        s += v;
      }
    }
    return s;
  }
  return;
}
function invocation(n: SyntaxNode): Invocation | undefined {
  const cn = n.children.find((c) => c.type === "command_name"),
    en = cn?.children.find((c) => c.isNamed);
  if (!en) return;
  const assignments = n.children
    .filter((c) => c.type === "variable_assignment")
    .map(envName);
  if (assignments.some((x) => !x)) return;
  return {
    executable: { raw: en.text, literal: literal(en) },
    assignments: assignments as string[],
    args: n.children
      .filter(
        (c) =>
          c.isNamed &&
          !["command_name", "variable_assignment", "file_redirect"].includes(
            c.type,
          ),
      )
      .map((c) => ({ raw: c.text, literal: literal(c) })),
  };
}
function unsupported(n: SyntaxNode, reason: string): Seed {
  return {
    kind: "command",
    text: n.text,
    situation: "workspace-neutral-or-indeterminate",
    allowed: false,
    reason,
  };
}
function command(n: SyntaxNode, ctx: WorkspaceContext, cwd: string): Seed {
  const i = invocation(n);
  if (!i?.executable.literal) return unsupported(n, "dynamic command name");
  if (i.assignments.some(risky))
    return unsupported(n, "high-risk environment assignment");
  const exe = i.executable.literal,
    name = exe.toLowerCase();
  if (name === "cd")
    return i.args.length === 1 && i.args[0]!.literal
      ? {
          kind: "command",
          text: n.text,
          effects: [{ kind: "read", path: i.args[0]!.literal! }],
          reason: "literal cd",
        }
      : unsupported(n, "unsupported cd");
  if (exe.includes("/") || exe.includes("\\"))
    return script(n, i, ctx, cwd, i.executable, 0);
  if (INTERPRETERS.has(name) || name === "source" || name === ".")
    return interpreter(n, i, ctx, cwd, name);
  if (name === "echo" || name === "printf") {
    const ok = name === "echo" ? true : safePrintf(i.args);
    return {
      kind: "command",
      text: n.text,
      situation: "workspace-neutral-or-indeterminate",
      allowed: ok,
      reason: ok ? "stdout profile" : "shell-state mutation",
    };
  }
  if (name === "curl") return curl(n, i);
  if (name === "git") return git(n, i, ctx, cwd);
  if (["npm", "pnpm", "yarn", "bun"].includes(name))
    return nodeFlow(n, i, ctx, cwd, name);
  if (name === "go") return goFlow(n, i, ctx, cwd);
  if (name === "cargo")
    return workflow(
      n,
      i,
      ctx,
      cwd,
      ["Cargo.toml", "?Cargo.lock"],
      new Set(["build", "test", "check", "fmt", "clippy"]),
      name,
    );
  if (name === "make") return make(n, i, ctx, cwd);
  if (name === "pip" || name === "pip3") return pip(n, i, ctx, cwd, 0);
  if (INFO[name]) {
    const values = i.args.map((a) => a.literal);
    const ok =
      values.every(Boolean) &&
      INFO[name]!.test(values.length ? " " + values.join(" ") : "");
    return {
      kind: "command",
      text: n.text,
      situation: "workspace-neutral-or-indeterminate",
      allowed: ok,
      reason: ok ? "information profile" : "unsupported information form",
    };
  }
  return (
    pathCommand(n, i, name) ?? unsupported(n, `unsupported command: ${name}`)
  );
}
function safePrintf(args: Word[]) {
  let index = 0;
  if (args[0]?.literal === "--") index = 1;
  const word = args[index],
    format = word?.literal;
  if (word?.raw.startsWith("$'")) return false;
  if (format === undefined || format.startsWith("-v")) return false;
  return !printfWritesVariable(format);
}
function printfWritesVariable(format: string) {
  for (let i = 0; i < format.length; i++) {
    if (format[i] !== "%") continue;
    if (format[i + 1] === "%") {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < format.length && /[-+ #0'0-9.*]/.test(format[j]!)) j++;
    if (format[j] === "n") return true;
    i = j;
  }
  return false;
}
function interpreter(
  n: SyntaxNode,
  i: Invocation,
  ctx: WorkspaceContext,
  cwd: string,
  name: string,
): Seed {
  if (
    name === "python" &&
    i.args[0]?.literal === "-m" &&
    i.args[1]?.literal === "pip"
  )
    return pip(n, i, ctx, cwd, 2);
  let x = 0;
  if (!["source", "."].includes(name) && i.args[0]?.literal === "--") x = 1;
  const entry = i.args[x];
  if (!entry?.literal || entry.literal === "-" || entry.literal.startsWith("-"))
    return unsupported(n, "unsupported interpreter or inline program");
  return script(n, i, ctx, cwd, entry, x + 1);
}
function script(
  n: SyntaxNode,
  i: Invocation,
  ctx: WorkspaceContext,
  cwd: string,
  entry: Word,
  start: number,
): Seed {
  if (!entry.literal) return unsupported(n, "dynamic script entry");
  const file = resolve(entry.literal, ctx, cwd);
  if (!file) return unsupported(n, "unresolved script entry");
  const inside = withinWorkspace(file, ctx.workspace),
    badArg = i.args
      .slice(start)
      .some(
        (a) =>
          a.literal === undefined ||
          (looksPath(a.literal) &&
            !withinWorkspace(
              resolve(a.literal, ctx, cwd) ?? "",
              ctx.workspace,
            )),
      );
  const ok = inside && ctx.baseline.status(file) === "clean" && !badArg;
  return {
    kind: "command",
    text: n.text,
    effects: [{ kind: "read", path: entry.literal }],
    allowed: ok,
    reason: ok
      ? "trusted workspace script"
      : "workspace script red line or external script",
    dependencies: inside ? [file] : [],
  };
}
function looksPath(v: string) {
  return (
    path.isAbsolute(v) ||
    v === "." ||
    v === ".." ||
    v.startsWith("./") ||
    v.startsWith("../") ||
    v.startsWith("~/") ||
    v.includes("/")
  );
}
function curl(n: SyntaxNode, i: Invocation): Seed {
  let url = false,
    ok = true;
  const flags = new Set([
      "-f",
      "-s",
      "-S",
      "-L",
      "-I",
      "--fail",
      "--silent",
      "--show-error",
      "--location",
      "--head",
      "--compressed",
    ]),
    values = new Set([
      "--connect-timeout",
      "--max-time",
      "--retry",
      "--retry-delay",
    ]);
  for (let x = 0; x < i.args.length; x++) {
    const a = i.args[x]!.literal;
    if (!a) {
      ok = false;
      break;
    }
    if (flags.has(a) || /^-[fsSLI]+$/.test(a)) continue;
    const eq = a.indexOf("="),
      opt = eq > 0 ? a.slice(0, eq) : a;
    if (values.has(opt)) {
      const v = eq > 0 ? a.slice(eq + 1) : i.args[++x]?.literal;
      if (!v || !/^\d+(\.\d+)?$/.test(v)) ok = false;
      continue;
    }
    if (a.startsWith("-") || url || !/^https?:\/\//i.test(a)) {
      ok = false;
      break;
    }
    url = true;
  }
  ok &&= url;
  return {
    kind: "command",
    text: n.text,
    situation: "workspace-neutral-or-indeterminate",
    allowed: ok,
    reason: ok ? "curl GET/HEAD profile" : "unsupported curl",
  };
}
function git(
  n: SyntaxNode,
  i: Invocation,
  ctx: WorkspaceContext,
  cwd: string,
): Seed {
  const a = i.args.map((x) => x.literal);
  if (a.some((x) => x === undefined)) return unsupported(n, "dynamic git");
  const v = a as string[];
  let x = 0,
    repo = cwd;
  if (v[0] === "-C") {
    const r = v[1] && resolve(v[1], ctx, cwd);
    if (!r) return unsupported(n, "unresolved git -C");
    repo = r;
    x = 2;
  }
  const sub = v[x];
  let ok = !!sub && GIT_ALL.has(sub) && gitArgs(sub!, v.slice(x + 1));
  if (!withinWorkspace(repo, ctx.workspace) && !GIT_READ.has(sub ?? ""))
    ok = false;
  return {
    kind: "command",
    text: n.text,
    situation: "workspace-neutral-or-indeterminate",
    allowed: ok,
    reason: ok ? `git ${sub}` : "unsupported git form",
  };
}
function gitArgs(sub: string, a: string[]) {
  if (sub === "commit") return commitArgs(a);
  const flags: Record<string, Set<string>> = {
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
    fetch: new Set(["--all", "--prune", "--tags", "--quiet", "--verbose"]),
  };
  const allowed = flags[sub];
  if (!allowed) return false;
  return a.every(
    (v) =>
      !v.startsWith("-") ||
      allowed.has(v) ||
      ((sub === "log" || sub === "show") && /^-\d+$/.test(v)) ||
      v.startsWith("--max-count=") ||
      v.startsWith("--untracked-files="),
  );
}
function commitArgs(a: string[]) {
  for (let x = 0; x < a.length; x++) {
    if (["-m", "--message"].includes(a[x]!)) {
      if (!a[++x]) return false;
    } else if (
      !a[x]!.startsWith("--message=") &&
      ![
        "-a",
        "--all",
        "--amend",
        "--no-edit",
        "--allow-empty",
        "--quiet",
      ].includes(a[x]!)
    )
      return false;
  }
  return true;
}
function nodeFlow(
  n: SyntaxNode,
  i: Invocation,
  ctx: WorkspaceContext,
  cwd: string,
  name: string,
): Seed {
  const a = i.args.map((x) => x.literal);
  let ok =
    withinWorkspace(cwd, ctx.workspace) &&
    a.every((x) => x !== undefined) &&
    (name === "npm"
      ? a[0] === "test" ||
        (a[0] === "run" && !!a[1] && !a[1]!.startsWith("-"))
      : a[0] === "run" && !!a[1] && !a[1]!.startsWith("-"));
  if (ok) ok = validNodeWorkflowTail(a as string[], name);
  return deps(n, ctx, cwd, ["package.json"], ok, `${name} workflow`);
}
function validNodeWorkflowTail(args: string[], name: string) {
  const start = name === "npm" && args[0] === "test" ? 1 : 2;
  const tail = args.slice(start);
  return tail.length === 0 || tail[0] === "--";
}
function workflow(
  n: SyntaxNode,
  i: Invocation,
  ctx: WorkspaceContext,
  cwd: string,
  files: string[],
  subs: Set<string>,
  name: string,
): Seed {
  const a = i.args.map((x) => x.literal);
  const ok =
    withinWorkspace(cwd, ctx.workspace) &&
    a.every((x) => x !== undefined) &&
    subs.has(a[0] ?? "") &&
    (a.slice(1) as string[]).every(
      (x) => !x.startsWith("-") || /^-[vx]$/.test(x),
    );
  return deps(n, ctx, cwd, files, ok, `${name} workflow`);
}
function goFlow(
  n: SyntaxNode,
  i: Invocation,
  ctx: WorkspaceContext,
  cwd: string,
): Seed {
  const a = i.args.map((x) => x.literal);
  let ok = a.every((x) => x !== undefined);
  const v = a as string[];
  if (v[0] === "mod")
    ok &&= ["download", "tidy"].includes(v[1] ?? "") && v.length === 2;
  else
    ok &&=
      ["build", "test", "vet", "fmt"].includes(v[0] ?? "") &&
      v.slice(1).every(
        (x) =>
          (!x.startsWith("-") || /^-[vx]$/.test(x)) &&
          (!looksPath(x) ||
            withinWorkspace(resolve(x, ctx, cwd) ?? "", ctx.workspace)),
      );
  ok &&= withinWorkspace(cwd, ctx.workspace);
  return deps(n, ctx, cwd, ["go.mod", "?go.sum"], ok, "go workflow");
}
function pip(
  n: SyntaxNode,
  i: Invocation,
  ctx: WorkspaceContext,
  cwd: string,
  start: number,
): Seed {
  const a = i.args.slice(start).map((x) => x.literal);
  if (a.some((x) => x === undefined)) return unsupported(n, "dynamic pip");
  const v = a as string[];
  if (["list", "show", "check", "freeze"].includes(v[0] ?? ""))
    return {
      kind: "command",
      text: n.text,
      situation: "workspace-neutral-or-indeterminate",
      allowed: v.slice(1).every((x) => !x.startsWith("-")),
      reason: "pip information",
    };
  if (v[0] === "install" && v[1] === "-r" && v.length === 3) {
    const f = resolve(v[2]!, ctx, cwd);
    return f && withinWorkspace(f, ctx.workspace)
      ? depsAbs(n, ctx, [f], true, "pip requirements")
      : unsupported(n, "external requirements");
  }
  if (v.join(" ") === "install .") {
    const fs = ["pyproject.toml", "setup.cfg", "setup.py"]
      .map((x) => path.join(cwd, x))
      .filter((x) => ctx.baseline.status(x) !== "absent");
    return depsAbs(
      n,
      ctx,
      fs,
      withinWorkspace(cwd, ctx.workspace) && fs.length > 0,
      "pip local install",
    );
  }
  return unsupported(n, "unsupported pip");
}
function make(
  n: SyntaxNode,
  i: Invocation,
  ctx: WorkspaceContext,
  cwd: string,
): Seed {
  const a = i.args.map((x) => x.literal);
  if (a.some((x) => x === undefined)) return unsupported(n, "dynamic make");
  const v = a as string[];
  let selected: string | undefined,
    ok = true;
  for (let x = 0; x < v.length; x++) {
    const arg = v[x]!;
    if (arg === "-f" || arg === "--file") {
      selected = v[++x];
      if (!selected) ok = false;
      continue;
    }
    if (/^-j\d+$/.test(arg) || /^--jobs=\d+$/.test(arg)) continue;
    if (arg === "-j" || arg === "--jobs") {
      if (!/^\d+$/.test(v[++x] ?? "")) ok = false;
      continue;
    }
    if (arg.startsWith("-") || arg.includes("=")) ok = false;
  }
  let file = selected && resolve(selected, ctx, cwd);
  if (!file)
    file = ["GNUmakefile", "Makefile"]
      .map((x) => path.join(cwd, x))
      .find((x) => ctx.baseline.status(x) !== "absent");
  if (!file || !withinWorkspace(file, ctx.workspace))
    return unsupported(n, "missing or external Makefile");
  return depsAbs(n, ctx, [file], ok, "make workflow");
}
function deps(
  n: SyntaxNode,
  ctx: WorkspaceContext,
  cwd: string,
  files: string[],
  shape: boolean,
  reason: string,
) {
  const absolute: string[] = [];
  let ok = shape;
  for (const item of files) {
    const optional = item[0] === "?",
      f = path.join(cwd, optional ? item.slice(1) : item),
      s = ctx.baseline.status(f);
    if (optional && s === "absent") continue;
    absolute.push(f);
    if (s !== "clean") ok = false;
  }
  return depsAbs(n, ctx, absolute, ok, reason);
}
function depsAbs(
  n: SyntaxNode,
  ctx: WorkspaceContext,
  files: string[],
  shape: boolean,
  reason: string,
): Seed {
  const ok =
    shape &&
    files.length > 0 &&
    files.every((f) => ctx.baseline.status(f) === "clean");
  return {
    kind: "command",
    text: n.text,
    situation: "workspace-neutral-or-indeterminate",
    allowed: ok,
    reason: ok ? reason : `${reason} requires clean committed files`,
    dependencies: files,
  };
}
function pathCommand(
  n: SyntaxNode,
  i: Invocation,
  name: string,
): Seed | undefined {
  const a = i.args.map((x) => x.literal);
  if (a.some((x) => x === undefined)) return unsupported(n, `dynamic ${name}`);
  const v = a as string[];
  if (READERS.has(name)) return paths(n, operands(v, name), "read", name);
  if (["rm", "rmdir"].includes(name))
    return paths(n, operands(v, name), "delete", name);
  if (["mkdir", "touch", "truncate", "shred", "tee"].includes(name))
    return paths(n, operands(v, name), "write", name);
  if (["chmod", "chown"].includes(name)) {
    const o = operands(v, name);
    return paths(n, o && o.length > 1 ? o.slice(1) : undefined, "write", name);
  }
  if (["cp", "mv", "ln"].includes(name)) {
    const o = operands(v, name);
    if (!o || o.length < 2) return unsupported(n, `unsupported ${name}`);
    return {
      kind: "command",
      text: n.text,
      effects: [
        ...o
          .slice(0, -1)
          .map(
            (x) =>
              ({
                kind: name === "mv" ? "move-source" : "read",
                path: x,
              }) as Effect,
          ),
        { kind: name === "mv" ? "move-destination" : "write", path: o.at(-1)! },
      ],
      reason: name,
    };
  }
  if (["rg", "ripgrep", "grep"].includes(name)) return search(n, v, name);
  if (name === "sed") return sed(n, v);
  if (name === "dd") {
    const e: Effect[] = [];
    for (const x of v) {
      if (x.startsWith("if=")) e.push({ kind: "read", path: x.slice(3) });
      else if (x.startsWith("of=")) e.push({ kind: "write", path: x.slice(3) });
      else if (!/^[a-z_]+=[^=]+$/i.test(x))
        return unsupported(n, "unsupported dd");
    }
    return e.length
      ? { kind: "command", text: n.text, effects: e, reason: "dd" }
      : unsupported(n, "dd without path");
  }
  return;
}
function operands(a: string[], name: string): string[] | undefined {
  const out: string[] = [],
    short = SHORT_OPTIONS[name] ?? "",
    long = LONG_OPTIONS[name] ?? new Set<string>();
  let opts = true;
  for (const x of a) {
    if (opts && x === "--") {
      opts = false;
      continue;
    }
    if (opts && x.startsWith("--")) {
      const key = x.split("=", 1)[0]!;
      if (!long.has(key) || x.includes("=")) return;
      continue;
    }
    if (opts && x.startsWith("-") && x !== "-") {
      if ([...x.slice(1)].some((c) => !short.includes(c))) return;
      continue;
    }
    out.push(x);
  }
  return out;
}
function search(n: SyntaxNode, a: string[], name: string): Seed {
  const out: string[] = [];
  let pattern = false;
  for (let x = 0; x < a.length; x++) {
    const v = a[x]!;
    if (v === "--") {
      if (!pattern) {
        if (!a[x + 1]) return unsupported(n, `missing ${name} pattern`);
        pattern = true;
        x++;
      }
      out.push(...a.slice(x + 1));
      break;
    }
    if (!pattern && v.startsWith("-")) {
      if (["-e", "--regexp", "-g", "--glob", "-t", "--type"].includes(v)) {
        if (!a[++x]) return unsupported(n, `missing ${name} option value`);
        if (v === "-e" || v === "--regexp") pattern = true;
        continue;
      }
      if (
        !/^-[nHhIiSsUvVwcClLo]+$/.test(v) &&
        ![
          "--hidden",
          "--follow",
          "--files",
          "--count",
          "--line-number",
          "--no-heading",
          "--fixed-strings",
        ].includes(v)
      )
        return unsupported(n, `unsupported ${name} option`);
      continue;
    }
    if (!pattern) pattern = true;
    else out.push(v);
  }
  if (!pattern) return unsupported(n, `missing ${name} pattern`);
  return out.length
    ? paths(n, out, "read", name)
    : {
        kind: "command",
        text: n.text,
        situation: "workspace-neutral-or-indeterminate",
        allowed: true,
        reason: `${name} cwd search`,
      };
}
function sed(n: SyntaxNode, a: string[]): Seed {
  let write = false,
    program: string | undefined;
  const files: string[] = [];
  for (let x = 0; x < a.length; x++) {
    const v = a[x]!;
    if (
      v === "-i" ||
      v === "--in-place" ||
      v.startsWith("-i") ||
      v.startsWith("--in-place=")
    ) {
      write = true;
      continue;
    }
    if (v === "-e" || v === "--expression") {
      program = a[++x];
      if (!program) return unsupported(n, "missing sed expression");
      continue;
    }
    if (["-n", "-E", "-r"].includes(v)) continue;
    if (v.startsWith("-")) return unsupported(n, "unsupported sed option");
    if (!program) program = v;
    else files.push(v);
  }
  if (!program) return unsupported(n, "missing sed program");
  if (
    /(?:^|[;}\n])\s*[eEwW](?:\s|$)|s(.).*?\1.*?\1[a-zA-Z]*[ewW]/.test(program)
  )
    return unsupported(
      n,
      "sed program has unmodeled execution or write effect",
    );
  return files.length
    ? paths(n, files, write ? "write" : "read", "sed")
    : {
        kind: "command",
        text: n.text,
        situation: "workspace-neutral-or-indeterminate",
        allowed: true,
        reason: "sed stdin",
      };
}
function paths(
  n: SyntaxNode,
  o: string[] | undefined,
  kind: Effect["kind"],
  reason: string,
): Seed {
  return o
    ? o.length
      ? {
          kind: "command",
          text: n.text,
          effects: o.map((path) => ({ kind, path })),
          reason,
        }
      : {
          kind: "command",
          text: n.text,
          situation: "workspace-neutral-or-indeterminate",
          allowed: true,
          reason: `${reason} without path`,
        }
    : unsupported(n, `unsupported ${reason}`);
}
function redirect(n: SyntaxNode): Seed {
  const op = n.children.find((c) => !c.isNamed)?.text,
    t = n.children.find((c) => c.isNamed && c.type !== "file_descriptor");
  if (!op || !t)
    return {
      kind: "redirect",
      text: n.text,
      situation: "workspace-neutral-or-indeterminate",
      allowed: false,
      reason: "unresolved redirect",
    };
  if ([">&", "<&"].includes(op) && (t.type === "number" || t.text === "-"))
    return {
      kind: "redirect",
      text: n.text,
      situation: "workspace-neutral-or-indeterminate",
      allowed: true,
      reason: "fd redirect",
    };
  const v = literal(t);
  if (!v)
    return {
      kind: "redirect",
      text: n.text,
      situation: "workspace-neutral-or-indeterminate",
      allowed: false,
      reason: "dynamic redirect",
    };
  if (v === "/dev/null")
    return {
      kind: "redirect",
      text: n.text,
      situation: "workspace-neutral-or-indeterminate",
      allowed: true,
      reason: "/dev/null",
    };
  const write = [">", ">>", "&>", "&>>", ">|", "<>"].includes(op);
  if (!write && op !== "<")
    return {
      kind: "redirect",
      text: n.text,
      situation: "workspace-neutral-or-indeterminate",
      allowed: false,
      reason: "unsupported redirect",
    };
  return {
    kind: "redirect",
    text: n.text,
    effects: [{ kind: write ? "write" : "read", path: v }],
    reason: "file redirect",
  };
}
function finish(s: Seed, ctx: WorkspaceContext, cwd: string): DecisionUnit {
  const effects = s.effects ?? [],
    r = effects.map((e) => ({ e, p: resolve(e.path, ctx, cwd) }));
  let situation = s.situation;
  if (!situation)
    situation = r.some((x) => !x.p)
      ? "workspace-neutral-or-indeterminate"
      : r.some((x) => !withinWorkspace(x.p!, ctx.workspace))
        ? "workspace-outside"
        : "workspace-inside";
  let ok = s.allowed ?? true,
    reason = s.reason;
  if (situation === "workspace-outside") {
    ok &&= effects.length > 0 && effects.every((e) => e.kind === "read");
    if (!ok) reason = "external write or unsupported external operation";
  } else if (situation === "workspace-neutral-or-indeterminate")
    ok &&= s.allowed === true;
  else
    for (const x of r) {
      if (!x.p) {
        ok = false;
        reason = "unresolved path";
        break;
      }
      if (x.e.kind !== "read" && hasGitSegment(x.p)) {
        ok = false;
        reason = "direct .git mutation";
        break;
      }
      if (
        ["delete", "move-source"].includes(x.e.kind) &&
        same(x.p, ctx.workspace)
      ) {
        ok = false;
        reason = "workspace root removal";
        break;
      }
    }
  const mutations = r
    .filter((x) => x.p && x.e.kind !== "read")
    .map((x) => x.p!);
  return {
    kind: s.kind,
    text: s.text,
    situation,
    action: ok ? "allow" : "ask",
    reason,
    mutationScopes: [...new Set(mutations)],
    stabilityDependencies: [...new Set(s.dependencies ?? [])],
  };
}
function cwds(commands: SyntaxNode[], ctx: WorkspaceContext) {
  const map = new Map<number, string>(),
    cds = commands.filter((n) => invocation(n)?.executable.literal === "cd");
  if (!cds.length) return { map };
  if (cds.length === 1 && commands.length === 1) return { map };
  if (cds.length !== 1 || commands.length !== 2 || commands[0] !== cds[0])
    return { map, reason: "unsupported cwd transition structure" };
  const cd = cds[0]!,
    nextCommand = commands[1]!,
    left = decisionContainer(cd),
    right = decisionContainer(nextCommand),
    list = left.parent;
  if (
    !list ||
    list.type !== "list" ||
    right.parent !== list ||
    list.namedChildren.length !== 2 ||
    list.namedChildren[0] !== left ||
    list.namedChildren[1] !== right ||
    !list.children.some((n) => !n.isNamed && n.text === "&&")
  )
    return { map, reason: "unsupported cwd transition operator" };
  const i = invocation(cd),
    raw = i?.args.length === 1 ? i.args[0]?.literal : undefined,
    next = raw && resolve(raw, ctx, ctx.cwd);
  if (!next) return { map, reason: "dynamic cwd transition" };
  map.set(nextCommand.startIndex, next);
  return { map };
}
function decisionContainer(command: SyntaxNode): SyntaxNode {
  return command.parent?.type === "redirected_statement"
    ? command.parent
    : command;
}
function cwdAt(n: SyntaxNode, map: Map<number, string>, fallback: string) {
  let out = fallback,
    at = -1;
  for (const [x, v] of map)
    if (x <= n.startIndex && x > at) {
      out = v;
      at = x;
    }
  return out;
}
function resolve(
  raw: string,
  ctx: WorkspaceContext,
  cwd: string,
): string | undefined {
  if (!raw || /[$`*?[\]{}()]/.test(raw)) return;
  let v = raw.replaceAll("\\", "/");
  if (v === "~") v = ctx.homedir;
  else if (v.startsWith("~/")) v = path.join(ctx.homedir, v.slice(2));
  else if (v.startsWith("~")) return;
  return path.normalize(path.isAbsolute(v) ? v : path.resolve(cwd, v));
}
export function hasGitSegment(v: string) {
  return v
    .replaceAll("\\", "/")
    .split("/")
    .some((x) => x.toLowerCase() === ".git");
}
export function withinWorkspace(v: string, workspace: string) {
  const a = path.normalize(v),
    b = path.normalize(workspace);
  return a === b || a.startsWith(b + path.sep);
}
function same(a: string, b: string) {
  return path.normalize(a) === path.normalize(b);
}
function overlap(a: string, b: string) {
  return withinWorkspace(a, b) || withinWorkspace(b, a);
}
export function defaultWorkspaceContext(
  workspace: string,
  cwd: string = workspace,
): WorkspaceContext {
  const root = path.normalize(workspace);
  return {
    workspace: root,
    cwd: path.normalize(cwd),
    homedir: os.homedir(),
    baseline: new GitBaseline(root),
  };
}
class GitBaseline implements BaselineInspector {
  constructor(private workspace: string) {}
  status(file: string): BaselineStatus {
    if (!withinWorkspace(file, this.workspace)) return "unknown";
    const rel = path.relative(this.workspace, file).replaceAll(path.sep, "/");
    if (!rel || rel.startsWith("../")) return "unknown";
    try {
      execFileSync(
        "git",
        ["-C", this.workspace, "cat-file", "-e", `HEAD:${rel}`],
        { stdio: "ignore", timeout: 1_000 },
      );
    } catch {
      return "absent";
    }
    try {
      execFileSync(
        "git",
        [
          "-C",
          this.workspace,
          "diff",
          "--quiet",
          "--no-ext-diff",
          "--no-textconv",
          "HEAD",
          "--",
          rel,
        ],
        { stdio: "ignore", timeout: 1_000 },
      );
      return "clean";
    } catch {
      return "dirty";
    }
  }
}
