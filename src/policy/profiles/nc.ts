import type { SyntaxNode } from "../../parser/node";
import type { Invocation, UnitSeed } from "../types";
import { unsupported } from "./helpers";

// nc is a network tool; only the loopback-literal probe family allows:
// a {-z,-v} flag cluster plus at most one -w TIMEOUT, then exactly one
// literal loopback host (localhost or 127.0.0.1) and a numeric port.
// Every egress shape — remote hosts, -l listen, -e exec, -U unix
// sockets, proxy/source options, service-name ports — stays ask.
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1"]);

export function recognizeNc(
  node: SyntaxNode,
  invocation: Invocation,
): UnitSeed {
  const args = invocation.args.map((argument) => argument.literal);
  if (args.some((argument) => argument === undefined))
    return unsupported(node, "dynamic nc");
  const values = args as string[];
  let sawTimeout = false;
  let index = 0;
  while (
    index < values.length &&
    values[index]!.startsWith("-") &&
    values[index] !== "-"
  ) {
    const argument = values[index]!;
    if (/^-[zv]+$/.test(argument)) {
      index += 1;
      continue;
    }
    const timeout = /^-w(\d+)?$/.exec(argument);
    if (timeout && !sawTimeout) {
      if (timeout[1]) index += 1;
      else {
        if (!/^\d+$/.test(values[index + 1] ?? ""))
          return unsupported(node, "unsupported nc option");
        index += 2;
      }
      sawTimeout = true;
      continue;
    }
    return unsupported(node, "unsupported nc option");
  }
  const operands = values.slice(index);
  if (operands.length !== 2) return unsupported(node, "unsupported nc operands");
  if (!LOOPBACK_HOSTS.has(operands[0]!))
    return unsupported(node, "unsupported nc host");
  if (!/^\d+$/.test(operands[1]!))
    return unsupported(node, "unsupported nc port");
  return {
    kind: "command",
    text: node.text,
    situation: "workspace-neutral-or-indeterminate",
    allowed: true,
    reason: "nc loopback probe",
  };
}
