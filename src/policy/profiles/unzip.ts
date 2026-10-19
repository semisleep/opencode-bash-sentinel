import type { SyntaxNode } from "../../parser/node";
import type { Effect, Invocation, UnitSeed } from "../types";
import { unsupported } from "./helpers";
import { literalArguments } from "./filesystem/options";

// Info-ZIP unzip, following the poppler template: the archive operand
// carries the read, and an explicit `-d` directory carries the write
// through the normal write situation — workspace/scratch targets allow,
// every other target asks. Member selectors (`*.txt`, `ppt/slides/*`) are
// archive-internal patterns matched by unzip itself, not filesystem
// paths: they ride along as opaque literals with no effect, quoted glob
// spellings included. Deliberately absent and fail-closed: extraction
// without `-d` (unzip would write into the cwd under derived names — the
// same implicit-write refusal as pdftotext's missing output), `-x`
// exclude patterns, `-Z` zipinfo mode, `-t`/`-e`/`-c` and every other
// cousin mode, clustered flags, a second `-d`, and a `-d` that swallows
// another flag as its value.

const LIST_FLAGS = new Set(["-l", "-v"]);
const EXTRACT_FLAGS = new Set(["-o", "-n", "-q"]);

type Parsed = {
  usage: boolean;
  list: boolean;
  pipe: boolean;
  archive?: string;
  members: string[];
  target?: string;
};

function parseUnzip(args: string[]): Parsed | undefined {
  // Bare unzip and a lone -v/-h print usage/version and exit.
  if (args.length === 0)
    return { usage: true, list: false, pipe: false, members: [] };
  if (args.length === 1 && (args[0] === "-v" || args[0] === "-h"))
    return { usage: true, list: false, pipe: false, members: [] };
  const parsed: Parsed = { usage: false, list: false, pipe: false, members: [] };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === "-d") {
      const value = args[++index];
      // One -d only, and it must not swallow another flag as its value.
      if (!value || value.startsWith("-") || parsed.target !== undefined)
        return;
      parsed.target = value;
      continue;
    }
    if (LIST_FLAGS.has(argument)) {
      parsed.list = true;
      continue;
    }
    if (argument === "-p") {
      parsed.pipe = true;
      continue;
    }
    if (EXTRACT_FLAGS.has(argument)) continue;
    if (!argument.startsWith("-")) {
      if (parsed.archive === undefined) parsed.archive = argument;
      else parsed.members.push(argument);
      continue;
    }
    return;
  }
  return parsed;
}

export function recognizeUnzip(
  node: SyntaxNode,
  invocation: Invocation,
): UnitSeed {
  const args = literalArguments(invocation);
  if (!args) return unsupported(node, "dynamic unzip");
  const parsed = parseUnzip(args);
  if (!parsed) return unsupported(node, "unsupported unzip");
  if (parsed.usage)
    return {
      kind: "command",
      text: node.text,
      situation: "workspace-neutral-or-indeterminate",
      allowed: true,
      reason: "unzip usage form",
    };
  const { archive, members } = parsed;
  if (!archive) return unsupported(node, "unzip requires an archive");
  // Exactly one mode: -l/-v listing, -p stdout, or extraction (which is
  // extraction only when -d names the target; a bare archive would
  // scatter derived writes into the cwd).
  const modes = [parsed.list, parsed.pipe, parsed.target !== undefined].filter(
    Boolean,
  ).length;
  if (modes !== 1) {
    if (parsed.list && parsed.pipe)
      return unsupported(node, "unsupported unzip");
    if (parsed.target !== undefined && (parsed.list || parsed.pipe))
      return unsupported(node, "unsupported unzip");
    return unsupported(node, "unzip requires an explicit -d target");
  }
  // Listing keeps -l/-v only; extraction keeps -o/-n/-q only, so a flag
  // from the wrong family riding along fails closed.
  if (parsed.list || parsed.pipe) {
    if (args.some((argument) => EXTRACT_FLAGS.has(argument)))
      return unsupported(node, "unsupported unzip");
    return command(node, [{ kind: "read", path: archive }]);
  }
  return command(node, [
    { kind: "read", path: archive },
    { kind: "write", path: parsed.target! },
  ]);
}

function command(node: SyntaxNode, effects: Effect[]): UnitSeed {
  return {
    kind: "command",
    text: node.text,
    effects: [effects[0]!, ...effects.slice(1)],
    reason: "unzip",
  };
}
