import type { SyntaxNode } from "../../parser/node";
import type { Invocation, UnitSeed } from "../types";
import { unsupported } from "./helpers";

// `opencode` is the host CLI. Only the closed usage surface allows: the
// print-and-exit flags {--help,-h,--version,-V} alone, or exactly one
// known subcommand followed by exactly one of them (`opencode run --help`
// prints that subcommand's usage and exits). Bare `opencode` launches
// the interactive TUI, and every other form — run prompts, serve, api,
// auth, plugin/mcp management, service control, upgrade — executes or
// mutates state this analyzer cannot see (trust model §2), so the
// grammar admits no path from those shapes to allow. Subcommand names
// are the v2 CLI's closed top-level set, alias `update` included.
const USAGE_FLAGS = new Set(["--help", "-h", "--version", "-V"]);
const SUBCOMMANDS = new Set([
  "acp",
  "api",
  "auth",
  "debug",
  "mcp",
  "mini",
  "models",
  "pair",
  "plugin",
  "reload",
  "run",
  "serve",
  "service",
  "session",
  "stats",
  "uninstall",
  "update",
  "upgrade",
]);

export function recognizeOpencode(
  node: SyntaxNode,
  invocation: Invocation,
): UnitSeed {
  const args = invocation.args.map((argument) => argument.literal);
  if (args.some((argument) => argument === undefined))
    return unsupported(node, "dynamic opencode");
  const values = args as string[];
  const usageOnly =
    values.length > 0 && values.every((value) => USAGE_FLAGS.has(value));
  const subcommandUsage =
    values.length === 2 &&
    SUBCOMMANDS.has(values[0]!) &&
    USAGE_FLAGS.has(values[1]!);
  if (!usageOnly && !subcommandUsage)
    return unsupported(node, "unsupported opencode form");
  return {
    kind: "command",
    text: node.text,
    situation: "workspace-neutral-or-indeterminate",
    allowed: true,
    reason: "opencode usage form",
  };
}
