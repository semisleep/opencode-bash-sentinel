import type { SyntaxNode } from "../../parser/node";
import type { Invocation, UnitSeed } from "../types";
import { unsupported } from "./helpers";

// pmset (macOS) manipulates host power management. Only the one-shot
// `-g` query forms allow: `-g` alone (settings in use) or `-g DOMAIN`
// from the closed set of display-only domains in pmset(1) GETTING,
// with nothing after the domain. Output is ps-class display data with
// no classification target. Everything that changes power state —
// setting writes (`pmset [-a|-b|-c|-u] setting value…`), sleepnow,
// displaysleepnow, touch, boot, noidle, restoredefaults,
// resetdisplayambientparams, schedule/repeat/relative — is excluded by
// requiring the exact `-g` head. The unbounded streaming log domains
// (pslog, rawlog, thermlog, assertionslog, sysloadlog, uuidlog,
// powerstatelog) and the variable-arity domains (powerstate,
// historydetailed, everything) stay outside the set and keep asking.
const READ_DOMAINS = new Set([
  "live",
  "custom",
  "cap",
  "sched",
  "ups",
  "ps",
  "batt",
  "therm",
  "assertions",
  "sysload",
  "ac",
  "adapter",
  "log",
  "uuid",
  "history",
  "stats",
  "systemstate",
  "sleepwakestats",
]);

export function recognizePmset(
  node: SyntaxNode,
  invocation: Invocation,
): UnitSeed {
  const args = invocation.args.map((argument) => argument.literal);
  if (args.some((argument) => argument === undefined))
    return unsupported(node, "dynamic pmset");
  const values = args as string[];
  if (values[0] !== "-g") return unsupported(node, "unsupported pmset form");
  const domain = values[1];
  if (domain !== undefined && (!READ_DOMAINS.has(domain) || values.length > 2))
    return unsupported(node, "unsupported pmset domain");
  return {
    kind: "command",
    text: node.text,
    situation: "workspace-neutral-or-indeterminate",
    allowed: true,
    reason: "pmset query",
  };
}
