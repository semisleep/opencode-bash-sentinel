import { parse } from "../parser";
import type { SyntaxNode } from "../parser/node";
import { resolvePath } from "./paths";
import type { Invocation, Word, WorkspaceContext } from "./types";

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
  // $?-style parameters expand to non-path scalars and degrade to dynamic
  // literals like variable_name; path-taking profiles still reject them.
  "special_variable_name",
  "declaration_command",
  "file_redirect",
  "file_descriptor",
  "number",
  "simple_expansion",
  "expansion",
  "comment",
]);

export type NormalizationResult =
  | { readonly ok: false; readonly reason: string }
  | {
      readonly ok: true;
      readonly commands: readonly SyntaxNode[];
      readonly assignments: readonly SyntaxNode[];
      readonly declarations: readonly SyntaxNode[];
      readonly redirects: readonly SyntaxNode[];
      cwdFor(node: SyntaxNode): string;
    };

export function normalizeBash(
  source: string,
  ctx: WorkspaceContext,
): NormalizationResult {
  const parsed = parse(source, { timeoutMs: 500, maxNodes: 10_000 });
  if (!parsed.ok) return { ok: false, reason: "parser resource budget exceeded" };
  if (parsed.hasError) return { ok: false, reason: "Bash parse failed" };
  const structural = validateTree(parsed.rootNode);
  if (structural) return { ok: false, reason: structural };

  const commands = collect(parsed.rootNode, "command");
  if (
    commands.some(
      (node) =>
        invocation(node)?.executable.literal === "cd" &&
        hasAncestor(node, "command_substitution"),
    )
  )
    return { ok: false, reason: "unsupported nested cwd transition" };

  const direct = commands.filter(
    (node) => !hasAncestor(node, "command_substitution"),
  );
  const cwdResult = cwdTransitions(direct, ctx);
  if (cwdResult.reason) return { ok: false, reason: cwdResult.reason };

  return {
    ok: true,
    commands,
    assignments: collect(parsed.rootNode, "variable_assignment").filter(
      (node) =>
        !hasAncestor(node, "command") &&
        !hasAncestor(node, "declaration_command"),
    ),
    declarations: collect(parsed.rootNode, "declaration_command"),
    redirects: collect(parsed.rootNode, "file_redirect"),
    cwdFor(node) {
      return cwdAt(node, cwdResult.map, ctx.cwd);
    },
  };
}

function validateTree(root: SyntaxNode): string | undefined {
  const stack = [root];
  while (stack.length) {
    const node = stack.pop()!;
    if (STRUCTURAL_DENY.has(node.type))
      return `unsupported Bash structure: ${node.type}`;
    if (node.isNamed && !CONSUMED_NAMED_NODES.has(node.type))
      return `unconsumed Bash node: ${node.type}`;
    if (
      node.type === "simple_expansion" &&
      !/^\$(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]+|[?#$!@*_-])$/.test(node.text)
    )
      return "unsupported Bash expansion: simple_expansion";
    if (
      node.type === "expansion" &&
      !/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(node.text)
    )
      return "unsupported Bash expansion: expansion";
    if (node.type === "word" && /(^|[^\\])[{}]/.test(node.text))
      return "unsupported Bash expansion: brace expansion";
    if (!node.isNamed && (node.text === "&" || node.text === "|&"))
      return `unsupported Bash operator: ${node.text}`;
    stack.push(...node.children);
  }
}

export function collect(root: SyntaxNode, type: string) {
  const output: SyntaxNode[] = [];
  const stack = [root];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.type === type) output.push(node);
    for (let index = node.children.length - 1; index >= 0; index--)
      stack.push(node.children[index]!);
  }
  return output;
}

export function hasAncestor(node: SyntaxNode, type: string) {
  for (let parent = node.parent; parent; parent = parent.parent)
    if (parent.type === type) return true;
  return false;
}

export function environmentName(node: SyntaxNode) {
  return node.children.find((child) => child.type === "variable_name")?.text;
}

export function literal(node: SyntaxNode): string | undefined {
  if (node.type === "number") return node.text;
  if (node.type === "word")
    return /[$`*?[\]{}()]/.test(node.text)
      ? undefined
      : node.text.replaceAll(/\\(.)/gs, "$1");
  if (node.type === "raw_string") return node.text.slice(1, -1);
  // Bash decodes ANSI-C escapes after parsing. Treating their source spelling
  // as the runtime value can hide path traversal, .git, or option prefixes.
  if (node.type === "ansi_c_string") return;
  if (node.type === "string" || node.type === "concatenation") {
    let value = "";
    for (const child of node.children) {
      if (!child.isNamed) continue;
      if (child.type === "string_content") value += child.text;
      else {
        const part = literal(child);
        if (part === undefined) return;
        value += part;
      }
    }
    return value;
  }
  return;
}

export function invocation(node: SyntaxNode): Invocation | undefined {
  const commandName = node.children.find(
    (child) => child.type === "command_name",
  );
  const executable = commandName?.children.find((child) => child.isNamed);
  if (!executable) return;
  const assignments = node.children
    .filter((child) => child.type === "variable_assignment")
    .map(environmentName);
  if (assignments.some((name) => !name)) return;
  return {
    executable: { raw: executable.text, literal: literal(executable) },
    assignments: assignments as string[],
    args: node.children
      .filter(
        (child) =>
          child.isNamed &&
          !["command_name", "variable_assignment", "file_redirect"].includes(
            child.type,
          ),
      )
      .map((child) => ({ raw: child.text, literal: literal(child) })),
  };
}

function cwdTransitions(commands: SyntaxNode[], ctx: WorkspaceContext) {
  const map = new Map<number, string>();
  const changes = commands.filter(
    (node) => invocation(node)?.executable.literal === "cd",
  );
  if (changes.length === 0) return { map };
  if (changes.length === 1 && commands.length === 1) return { map };
  if (
    changes.length !== 1 ||
    commands.length !== 2 ||
    commands[0] !== changes[0]
  )
    return { map, reason: "unsupported cwd transition structure" };

  const cd = changes[0]!;
  const nextCommand = commands[1]!;
  const left = decisionContainer(cd);
  const right = decisionContainer(nextCommand);
  const list = left.parent;
  if (
    !list ||
    list.type !== "list" ||
    right.parent !== list ||
    list.namedChildren.length !== 2 ||
    list.namedChildren[0] !== left ||
    list.namedChildren[1] !== right ||
    !list.children.some((node) => !node.isNamed && node.text === "&&")
  )
    return { map, reason: "unsupported cwd transition operator" };

  const parsed = invocation(cd);
  const raw =
    parsed?.args.length === 1 ? parsed.args[0]?.literal : undefined;
  const next = raw && resolvePath(raw, ctx, ctx.cwd);
  if (!next) return { map, reason: "dynamic cwd transition" };
  map.set(nextCommand.startIndex, next);
  return { map };
}

function decisionContainer(command: SyntaxNode): SyntaxNode {
  return command.parent?.type === "redirected_statement"
    ? command.parent
    : command;
}

function cwdAt(node: SyntaxNode, map: Map<number, string>, fallback: string) {
  let cwd = fallback;
  let position = -1;
  for (const [start, value] of map)
    if (start <= node.startIndex && start > position) {
      cwd = value;
      position = start;
    }
  return cwd;
}
