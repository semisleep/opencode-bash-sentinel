// Resident analyzer probe for the why-ask / attack-triage skills.
//
// Usage:
//   npx tsx .agents/skills/why-ask/probe.ts [options] [probe-file...]
//   printf '%s\n' 'rg -n x src' | npx tsx .agents/skills/why-ask/probe.ts
//
// Each probe file holds one shell command per line; blank lines and lines
// starting with `#` are skipped. With no file arguments, commands are read
// from stdin (one per line). Commands travel through a file or stdin, never
// argv: wildcard- or `$`-bearing arguments fail the engine's visible-argument
// check, so argv passing would prompt.
//
// The probe uses the real default workspace context (live git baseline), so
// its verdicts match what the runtime plugin would decide for this checkout.
// For counterfactual contexts (fake dirty baseline, foreign homedir), fall
// back to a throwaway script in the system temp dir and expect one prompt.
//
// Options:
//   --units   also print the per-decision-unit breakdown

import { readFileSync } from "node:fs"
import {
  analyzeWorkspacePolicy,
  defaultWorkspaceContext,
} from "../../../src/workspace-policy"

const flags = process.argv.filter((argument) => argument.startsWith("--"))
const files = process.argv.slice(2).filter((argument) => !argument.startsWith("--"))

function commandsFrom(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
}

let source: string
if (files.length > 0) {
  source = files.map((file) => readFileSync(file, "utf8")).join("\n")
} else if (!process.stdin.isTTY) {
  source = readFileSync(0, "utf8")
} else {
  console.error(
    "usage: npx tsx .agents/skills/why-ask/probe.ts [--units] [probe-file...]",
  )
  process.exit(2)
}

const commands = commandsFrom(source)
if (commands.length === 0) {
  console.error("no commands to probe")
  process.exit(2)
}

const root = process.cwd()
const ctx = defaultWorkspaceContext(root)

let asks = 0
for (const command of commands) {
  const decision = analyzeWorkspacePolicy(command, ctx)
  if (decision.action === "ask") asks++
  console.log(
    `${decision.action}\t${decision.reason ?? "-"}\t${command.slice(0, 120)}`,
  )
  if (flags.includes("--units")) {
    for (const unit of decision.units ?? []) {
      console.log(
        `  unit ${unit.action}\t${unit.situation}\t${unit.reason ?? "-"}\t${unit.text.slice(0, 100)}`,
      )
    }
  }
}
console.log(`${commands.length} probed, ${asks} ask`)
