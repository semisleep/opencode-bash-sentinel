import type { SyntaxNode } from "../../parser/node";
import type { Invocation, UnitSeed } from "../types";
import { unsupported } from "./helpers";

// macOS unified log. Only the read-only `log show` query surface allows:
// a time window (--start/--end/--last with literal timestamps or
// durations from a path-free charset), a closed --style enum, the
// display-only --info/--debug toggles, and --predicate expressions over
// a bounded charset with balanced quotes and parentheses. Every other
// verb is excluded by the grammar itself: `collect` writes an archive
// (--output), `config` mutates logging settings, `stream` is an
// unbounded follower, `stats` is unreviewed, and `show` never admits a
// positional operand or an archive input. A leading `-` never parses as
// an option value, so a missing value cannot swallow the next flag.
const STYLES = new Set(["syslog", "system", "compact"]);
const TIME = /^[0-9A-Za-z:+\-., ]+$/;
const PREDICATE_CHARSET = /^[A-Za-z0-9_:.\"()\[\]=<>!, -]+$/;

export function recognizeLog(
  node: SyntaxNode,
  invocation: Invocation,
): UnitSeed {
  const args = invocation.args.map((argument) => argument.literal);
  if (args.some((argument) => argument === undefined))
    return unsupported(node, "dynamic log");
  const values = args as string[];
  if (values[0] !== "show")
    return unsupported(node, "unsupported log subcommand");
  for (let index = 1; index < values.length; index++) {
    const value = values[index]!;
    if (value.startsWith("--style=")) {
      if (!STYLES.has(value.slice("--style=".length)))
        return unsupported(node, "unsupported log style");
      continue;
    }
    if (value === "--style") {
      const style = values[++index];
      if (!style || style.startsWith("-") || !STYLES.has(style))
        return unsupported(node, "unsupported log style");
      continue;
    }
    if (value === "--start" || value === "--end" || value === "--last") {
      const time = values[++index];
      if (!time || time.startsWith("-") || !TIME.test(time))
        return unsupported(node, "unsupported log time");
      continue;
    }
    if (value === "--predicate") {
      const predicate = values[++index];
      if (!predicate || !balancedPredicate(predicate))
        return unsupported(node, "unsupported log predicate");
      continue;
    }
    if (value === "--info" || value === "--debug") continue;
    return unsupported(node, "unsupported log option");
  }
  return {
    kind: "command",
    text: node.text,
    situation: "workspace-neutral-or-indeterminate",
    allowed: true,
    reason: "log show query",
  };
}

function balancedPredicate(predicate: string): boolean {
  return (
    !predicate.startsWith("-") &&
    PREDICATE_CHARSET.test(predicate) &&
    (predicate.match(/"/g)?.length ?? 0) % 2 === 0 &&
    balancedParentheses(predicate)
  );
}

function balancedParentheses(text: string): boolean {
  let depth = 0;
  for (const character of text) {
    if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}
