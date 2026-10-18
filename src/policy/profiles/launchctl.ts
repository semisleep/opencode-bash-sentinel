import type { SyntaxNode } from "../../parser/node";
import type { Invocation, UnitSeed } from "../types";
import { unsupported } from "./helpers";

// launchctl manages the host's launchd jobs. Only the job-table print
// `list` — optionally scoped to one literal service label, which is a
// launchd lookup key and not a filesystem path — allows, as ps-class
// display data with no classification target. Every mutating or
// signalling verb (load/unload, bootstrap/bootout, enable/disable,
// start/stop, kickstart, kill, submit, reboot, …) is excluded by the
// grammar itself and keeps asking.
export function recognizeLaunchctl(
  node: SyntaxNode,
  invocation: Invocation,
): UnitSeed {
  const args = invocation.args.map((argument) => argument.literal);
  if (args.some((argument) => argument === undefined))
    return unsupported(node, "dynamic launchctl");
  const values = args as string[];
  if (values[0] !== "list")
    return unsupported(node, "unsupported launchctl subcommand");
  const label = values[1];
  if (label !== undefined && (label.startsWith("-") || values.length > 2))
    return unsupported(node, "unsupported launchctl form");
  return {
    kind: "command",
    text: node.text,
    situation: "workspace-neutral-or-indeterminate",
    allowed: true,
    reason: "launchctl job listing",
  };
}
