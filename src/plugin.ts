import type { Plugin } from "@opencode/plugin"
import { execFileSync } from "node:child_process"
import os from "node:os"
import path from "node:path"
import {
  clearAlert,
  fireAlert,
  parseAlertOption,
  type AlertConfig,
} from "./alert"
import { analyzeCommandPolicy, type DangerousVerdict, type PolicyGate } from "./policy-engine"
import {
  scratchMutationVerdict,
  sensitiveVerdict,
} from "./policy/path-domain"
import {
  defaultWorkspaceContext,
  hasGitSegment,
  stripTrailingSeparators,
  withinWorkspace,
  type WorkspaceContext,
} from "./workspace-policy"
import { BUILD_ID } from "./version"

export interface BashSentinelOptions {
  audit?: boolean
  logPath?: string
  /** Additional sensitive-read roots, unioned with the ADR-0002 defaults. */
  sensitivePaths?: string[]
  /** ADR-0004 scratch roots: unset = host defaults, false = off, array = replace. */
  scratchPaths?: string[] | false
  /** Escalation alerts: sound plus an iTerm2 tab mark, cleared on reply. */
  alert?: boolean | {
    sound?: boolean | string
    mark?: boolean
  }
  /**
   * System-prompt guidance for the agent (session `context` hook):
   * unset/true = built-in text, string = custom text, false = off. Advisory
   * only — it never affects permission verdicts.
   */
  guidance?: boolean | string
}

const DEFAULT_LOG_PATH = "~/.local/share/opencode/bash-sentinel-audit.jsonl"

// Advisory nudge toward the analyzer's positive-recognition surface: the
// forms listed here are examples, not a catalogue claim, and the agent is
// told to prefer plain commands only when they are equally expressive.
const DEFAULT_GUIDANCE = `## Shell gate guidance (opencode-bash-sentinel)

A permission gate auto-approves only literal, statically recognizable Bash commands; anything else prompts the user and stalls your turn. To keep progress unattended:

- Prefer plain commands over ad-hoc scripts: rg/grep for search, ls/cat to inspect, cp/mv/mkdir/rm and git for workspace changes, npm/pip/cargo/go/make (or npx with a dependency declared in package.json) for builds and tests.
- Prefer the project's npm scripts over \`npx <bin>\` when the binary name differs from its package: npx auto-allows only literal dependency names, so \`npx tsc\` (package \`typescript\`) always prompts, while \`npm run typecheck\` runs the same typecheck unattended.
- Avoid shapes that always prompt: running a temporary script you just wrote, heredocs, pipes into interpreters (\`| sh\`, \`| python\`), and $VARS or $(cmd) wherever an argument names a path, a sed/awk-style script, or an option value. Send scratch output to the system temp dir (/tmp).
- Modify existing files with the edit tool, never scripted rewrites: \`python3 - <<EOF\` replace loops and \`perl -i\` one-liners always prompt, hide the exact change, and silently no-op when the needle doesn't match, while the edit tool shows a precise before/after and fails loudly on mismatch. sed -i is for mechanical renames across many files.
- When a command needs a computed value (line number, PID, file list), run the producer first, read its output, then rerun with the literal: \`sed -n "$(rg -n pattern f | cut -d: -f1)p" f\` prompts, while \`rg pattern f\` then \`sed -n 12p f\` runs unattended.
- One unrecognized segment escalates an entire \`&&\`/\`;\` line; split mixed lines so recognized parts do not wait on the rest.
- When a form prompts, restructure it into simpler commands instead of retrying cosmetic variations. Reserve scripts for logic that genuinely cannot be a few plain commands, and expect that prompt.`

// ADR-0006 §3: the finite catalogue of tools whose input Sentinel records.
// All are `codemode: false` in OpenCode 2.0.18, so a call ID names exactly
// one invocation of exactly one tool.
const CONSUMED_TOOLS = new Set(["shell", "read", "glob", "grep", "edit", "write", "patch"])

// ADR-0006 §3/§9: bounds for the correlation map and interpreter observations.
const MAX_RECORDS = 256

// The only interpreter whose grammar the analyzer implements (ADR-0006 §9).
const BASH = "bash"

const GLOB_CHARS = /[*?[\]{}]/

const auditTails = new Map<string, Promise<void>>()

/** Structural view of the engine's `permission.evaluate` event. */
type Evaluation = {
  readonly sessionID: string
  readonly agent?: string
  readonly action: string
  readonly resources: ReadonlyArray<string>
  readonly metadata?: Record<string, unknown>
  readonly source?: { readonly type: string; readonly id: string }
  effect: "allow" | "deny" | "ask"
}

/** Snapshot of the tool input fields the gate rules read (ADR-0006 §3). */
type Invocation = {
  readonly tool: string
  readonly command?: string
  readonly workdir?: string
  readonly path?: string
  poisoned: boolean
}

type Observation = { readonly command: string; readonly interpreter: string }

type Decision =
  | { readonly allow: true; readonly subject: string }
  | {
      readonly allow: false
      readonly subject: string
      readonly verdict: DangerousVerdict
      readonly reason: string
    }

const ask = (subject: string, reason: string, verdict: DangerousVerdict = { kind: "unanalyzable" }): Decision => ({
  allow: false,
  subject,
  verdict,
  reason,
})

export const BashSentinelPlugin: Plugin.Plugin = {
  id: "opencode-bash-sentinel",
  setup: async (ctx) => {
    const config = parseOptions(ctx.options)
    const directory = ctx.location.directory
    const project = ctx.location.project.directory
    // Mirrors the engine's internal/external split: a project rooted at the
    // filesystem root does not count as a containment boundary.
    const workspace = project !== path.parse(project).root ? project : directory
    const scratchRoots =
      config.scratchPaths === undefined
        ? defaultScratchRoots(workspace)
        : config.scratchPaths === false
          ? []
          : config.scratchPaths
    // Created once: the baseline inspector is shared by every per-call context
    // derived below. It pins nothing (ADR-0007) — trust follows the current
    // HEAD at each decision.
    const base = defaultWorkspaceContext(
      workspace,
      directory,
      config.sensitivePaths,
      scratchRoots,
    )

    const calls = new Map<string, Invocation>()
    const observations: Observation[] = []
    const warned = new Set<string>()

    await ctx.tool.hook("execute.before", (event) => {
      try {
        if (!CONSUMED_TOOLS.has(event.tool)) return
        const key = callKey(event.sessionID, event.id)
        const existing = calls.get(key)
        if (existing) {
          existing.poisoned = true
          return
        }
        if (calls.size >= MAX_RECORDS) calls.delete(calls.keys().next().value!)
        calls.set(key, snapshot(event.tool, event.input))
      } catch {
        // Recording is best-effort; a missing record fails closed.
      }
    })

    await ctx.tool.hook("execute.after", (event) => {
      try {
        const key = callKey(event.sessionID, event.id)
        const record = calls.get(key)
        calls.delete(key)
        if (record?.tool !== "shell" || record.command === undefined) return
        const index = observations.findIndex((item) => item.command === record.command)
        if (index >= 0) observations.splice(index, 1)
      } catch {
        // Cleanup is best-effort; bounded eviction covers leaks.
      }
    })

    await ctx.shell.hook("create.before", (invocation) => {
      try {
        if (observations.length >= MAX_RECORDS) observations.shift()
        observations.push({
          command: invocation.command,
          interpreter: path.basename(invocation.shell),
        })
      } catch {
        // A missing observation fails closed at the dialect gate.
      }
    })

    await ctx.permission.hook("evaluate", (event) => {
      try {
        evaluate(event)
      } catch {
        // ADR-0006 §2.3: a rejection here would fail the tool call inside the
        // engine; leaving `effect` untouched keeps the engine's own verdict.
      }
    })

    if (config.guidance !== undefined) {
      const text = config.guidance
      // The engine triggers `context` only for primary agent requests;
      // compaction, title and generate requests have their own hooks.
      await ctx.session.hook("context", (event) => {
        event.system.push({ type: "text", text })
      })
    }

    const events = new AbortController()
    if (config.alert) void clearAlertsOnReply(ctx, events.signal, config.alert)

    return () => events.abort()

    function evaluate(event: Evaluation): void {
      if (event.effect === "allow") return reportAllowed(event)
      if (event.effect !== "ask") return
      const gate = event.action
      if (gate !== "shell" && gate !== "external_directory" && gate !== "edit") return

      const decision = decide(event)
      if (config.audit) {
        void writeAudit(
          config.logPath,
          decision.subject,
          decision.allow ? undefined : decision.verdict,
          decision.allow ? "approve" : "escalate",
          gate,
          decision.allow ? undefined : decision.reason,
        )
      }
      if (decision.allow) {
        event.effect = "allow"
        return
      }
      if (config.alert) fireAlert(config.alert)
    }

    function decide(event: Evaluation): Decision {
      if (event.action === "edit") return decideEdit(event.resources)

      const record = correlate(event)
      const subject = record?.command ?? record?.path ?? event.resources.join(" ")
      if (!record) return ask(subject, "uncorrelated")
      if (record.poisoned) return ask(subject, "uncorrelated: duplicate call id")

      if (event.action === "shell") {
        if (record.tool !== "shell") return ask(subject, `uncorrelated: tool ${record.tool}`)
        return decideShell(record, event.resources, "shell")
      }

      switch (record.tool) {
        case "shell":
          return decideShell(record, undefined, "external_directory")
        case "read":
        case "glob":
        case "grep":
          return decideExternalRead(record, event.resources)
        case "write":
        case "edit":
          return decideExternalWrite(record.path, event.resources, subject)
        case "patch":
          return decidePatch(event, subject)
        default:
          return ask(subject, `uncorrelated: tool ${record.tool}`)
      }
    }

    function decideShell(
      record: Invocation,
      resources: ReadonlyArray<string> | undefined,
      gate: PolicyGate,
    ): Decision {
      const command = record.command
      if (command === undefined || command.length === 0) return ask("(no command)", "uncorrelated: no command")
      // Binding (ADR-0006 §4): both engine scanners emit trimmed slices of
      // the command, so a rewrite after capture shows up as a non-substring.
      if (resources !== undefined) {
        if (resources.length === 0 || !resources.every((resource) => command.includes(resource)))
          return ask(command, "binding mismatch")
      }
      // Dialect gate (ADR-0006 §9): every observation of this exact command
      // text must have run under Bash.
      const seen = observations.filter((item) => item.command === command)
      if (seen.length === 0) return ask(command, "dialect: unobserved")
      const foreign = seen.find((item) => item.interpreter !== BASH)
      if (foreign) return ask(command, `dialect: ${foreign.interpreter}`)

      const cwd = record.workdir === undefined ? directory : resolveInput(record.workdir)
      if (cwd === undefined) return ask(command, "unresolved workdir")
      const decision = analyzeCommandPolicy(command, withCwd(cwd), { gate })
      return decision.action === "allow"
        ? { allow: true, subject: command }
        : ask(command, decision.reason, decision.verdict)
    }

    function decideExternalRead(record: Invocation, resources: ReadonlyArray<string>): Decision {
      const raw = record.path ?? "."
      const target = resolveInput(raw)
      if (target === undefined) return ask(raw, "unresolved path")
      const [resource] = resources
      if (
        resources.length !== 1 ||
        (resource !== path.join(target, "*") && resource !== path.join(path.dirname(target), "*"))
      )
        return ask(target, "binding mismatch")
      // Target-only, exactly like the Bash read rule (ADR-0006 §4 notes).
      const verdict = sensitiveVerdict(target, base)
      return verdict.allow
        ? { allow: true, subject: target }
        : ask(target, verdict.reason, { kind: "dangerous", command: "external read: sensitive path" })
    }

    function decideExternalWrite(
      raw: string | undefined,
      resources: ReadonlyArray<string>,
      subject: string,
    ): Decision {
      if (raw === undefined) return ask(subject, "unresolved path")
      const target = resolveInput(raw)
      if (target === undefined) return ask(raw, "unresolved path")
      if (resources.length !== 1 || resources[0] !== path.join(path.dirname(target), "*"))
        return ask(target, "binding mismatch")
      return externalMutation(target)
    }

    function decidePatch(event: Evaluation, subject: string): Decision {
      const filepath = event.metadata?.filepath
      const parentDir = event.metadata?.parentDir
      if (typeof filepath !== "string" || !path.isAbsolute(filepath) || GLOB_CHARS.test(filepath))
        return ask(subject, "unresolved path")
      const target = path.normalize(filepath)
      if (
        parentDir !== path.dirname(target) ||
        event.resources.length !== 1 ||
        event.resources[0] !== path.join(path.dirname(target), "*")
      )
        return ask(target, "binding mismatch")
      return externalMutation(target)
    }

    // ADR-0005 shared mutation rule for write-origin directory asks
    // (ADR-0006 §6): sensitive first, then strict scratch descendants.
    function externalMutation(target: string): Decision {
      const sensitive = sensitiveVerdict(target, base)
      if (!sensitive.allow)
        return ask(target, sensitive.reason, { kind: "dangerous", command: "external write: sensitive path" })
      const scratch = scratchMutationVerdict(target, base)
      return scratch.allow
        ? { allow: true, subject: target }
        : ask(target, scratch.reason, { kind: "dangerous", command: "external write: outside scratch" })
    }

    function decideEdit(resources: ReadonlyArray<string>): Decision {
      const subject = resources.join(" ")
      if (resources.length === 0) return ask("(no resources)", "unresolved path")
      for (const resource of resources) {
        const target = resolveInput(resource)
        if (target === undefined) return ask(subject, "unresolved path")
        const verdict = editVerdict(target)
        if (verdict !== undefined) return ask(target, verdict.command, verdict)
      }
      return { allow: true, subject }
    }

    // ADR-0005: workspace containment first with a workspace-scoped `.git`
    // red line; external edits follow the shared mutation rule with the
    // sensitive red line evaluated first.
    function editVerdict(filepath: string): Extract<DangerousVerdict, { kind: "dangerous" }> | undefined {
      if (withinWorkspace(filepath, base.workspace))
        return hasGitSegment(filepath) === true ? { kind: "dangerous", command: "edit: .git path" } : undefined
      if (!sensitiveVerdict(filepath, base).allow) return { kind: "dangerous", command: "edit: sensitive path" }
      return scratchMutationVerdict(filepath, base).allow
        ? undefined
        : { kind: "dangerous", command: "edit: outside workspace" }
    }

    // ADR-0006 §11: arriving allows are never changed, only made visible.
    function reportAllowed(event: Evaluation): void {
      const action = event.action
      if (action !== "shell" && action !== "edit" && action !== "external_directory") return
      const record = action === "edit" ? undefined : correlate(event)
      if (action === "external_directory" && !record) return
      if (config.audit) {
        void writeAudit(
          config.logPath,
          record?.command ?? record?.path ?? event.resources.join(" "),
          undefined,
          "engine-allowed",
          action,
          `agent: ${event.agent ?? "unknown"}`,
        )
      }
      if (action === "external_directory") return
      const key = `${event.agent ?? "unknown"}\0${action}`
      if (warned.has(key)) return
      warned.add(key)
      console.warn(
        `[opencode-bash-sentinel] ${action} requests from agent "${event.agent ?? "unknown"}" arrive already allowed, so Sentinel is not consulted for them. Unless this comes from your own specific allow rules or saved "always" grants, the per-agent ask baseline is missing: add { "action": "${action}", "resource": "*", "effect": "ask" } to agents.<id>.permissions (not top-level permissions).`,
      )
    }

    function correlate(event: Evaluation): Invocation | undefined {
      if (event.source?.type !== "tool") return undefined
      return calls.get(callKey(event.sessionID, event.source.id))
    }

    // The engine's own lexical rule (FileAccess.resolvePath): `~` and `~/`
    // expand to home, everything else resolves from the location directory.
    function resolveInput(raw: string): string | undefined {
      if (raw.length === 0 || GLOB_CHARS.test(raw)) return undefined
      const home = os.homedir()
      const expanded = raw === "~" ? home : raw.startsWith("~/") ? path.join(home, raw.slice(2)) : raw
      if (expanded.startsWith("~")) return undefined
      return path.resolve(directory, expanded)
    }

    function withCwd(cwd: string): WorkspaceContext {
      return cwd === base.cwd ? base : { ...base, cwd }
    }
  },
}

function snapshot(tool: string, input: unknown): Invocation {
  const fields = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {}
  const text = (value: unknown) => (typeof value === "string" ? value : undefined)
  let target = text(fields.path)
  // The glob tool treats these literal strings as an absent path.
  if (tool === "glob" && (target === "undefined" || target === "null")) target = undefined
  return {
    tool,
    command: text(fields.command),
    workdir: text(fields.workdir),
    path: target,
    poisoned: false,
  }
}

function callKey(sessionID: string, id: string): string {
  return `${sessionID}\0${id}`
}

async function clearAlertsOnReply(ctx: Plugin.Context, signal: AbortSignal, alert: AlertConfig): Promise<void> {
  try {
    for await (const event of ctx.event.subscribe({ signal })) {
      if ((event as { type?: unknown }).type === "permission.replied") clearAlert(alert)
    }
  } catch {
    // The stream ends on unload or engine shutdown; alerts are advisory.
  }
}

function parseOptions(options: unknown): {
  audit: boolean
  logPath: string
  sensitivePaths: string[]
  scratchPaths: string[] | false | undefined
  alert: AlertConfig | undefined
  guidance: string | undefined
} {
  const raw = (options ?? {}) as BashSentinelOptions
  return {
    audit: raw.audit === true,
    logPath: typeof raw.logPath === "string" && raw.logPath.length > 0 ? raw.logPath : DEFAULT_LOG_PATH,
    sensitivePaths: Array.isArray(raw.sensitivePaths)
      ? raw.sensitivePaths.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
      : [],
    scratchPaths:
      raw.scratchPaths === false
        ? false
        : Array.isArray(raw.scratchPaths)
          ? raw.scratchPaths.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
          : undefined,
    alert: parseAlertOption(raw.alert),
    guidance:
      raw.guidance === false
        ? undefined
        : typeof raw.guidance === "string" && raw.guidance.length > 0
          ? raw.guidance
          : DEFAULT_GUIDANCE,
  }
}

// ADR-0004 default scratch roots (host layer; the engine ships no defaults).
// /tmp plus its darwin /private/tmp spelling — matching is lexical and the
// symlink is not canonicalized. The per-user temp directory joins from two
// sources: $TMPDIR when set (respecting a custom location), and on darwin
// getconf DARWIN_USER_TEMP_DIR, which resolves the real per-user directory
// even when a service-spawned host has no TMPDIR in its environment. Every
// resolved root is registered in both darwin spellings (/var/X and
// /private/var/X) because matching is lexical. /var/tmp and /run/user are
// excluded: persistent or session state, not ephemeral by convention. Never
// read $TMPDIR at analysis time; the resolved value is fixed here, once per
// plugin context.
export function defaultScratchRoots(workspace: string): string[] {
  const roots = new Set<string>(["/tmp"])
  if (process.platform === "darwin") roots.add("/private/tmp")
  const candidates = [process.env.TMPDIR]
  if (process.platform === "darwin") candidates.push(darwinUserTempDir())
  for (const candidate of candidates) {
    if (!candidate) continue
    for (const spelling of darwinSpellings(candidate)) {
      const root = stripTrailingSeparators(path.normalize(spelling))
      if (!path.isAbsolute(root)) continue
      // Each spelling is guarded on its own: the spelling that lexically
      // covers a real tree (home or the workspace) drops out, so a
      // workspace inside the temp tree never sinks into a scratch root.
      if (!coversRealTree(root, path.normalize(workspace))) roots.add(root)
    }
  }
  return [...roots]
}

// confstr(_CS_DARWIN_USER_TEMP_DIR) via its CLI face: the per-user temp
// directory, independent of the environment a daemon was spawned with. Any
// failure just drops the candidate, leaving the static roots.
function darwinUserTempDir(): string | undefined {
  try {
    return execFileSync("getconf", ["DARWIN_USER_TEMP_DIR"], {
      encoding: "utf8",
      timeout: 1_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
  } catch {
    return undefined
  }
}

// Lexical matching never crosses the /private symlink, so a darwin path
// under /var or /tmp must be registered in both spellings.
function darwinSpellings(value: string): string[] {
  if (value.startsWith("/private/")) return [value, value.slice("/private".length)]
  if (/^\/(?:var|tmp)\//.test(value)) return [value, `/private${value}`]
  return [value]
}

// A temp directory must not swallow real trees: reject a TMPDIR that equals
// or lexically contains the home directory or the workspace root (for
// example TMPDIR=$HOME), which would auto-approve mutations far outside any
// temp location. Narrowing only — a rejected TMPDIR simply drops out.
function coversRealTree(candidate: string, workspace: string): boolean {
  const root = stripTrailingSeparators(path.normalize(candidate))
  return [os.homedir(), workspace].some((directory) => {
    const value = stripTrailingSeparators(path.normalize(directory))
    return value === root || value.startsWith(root + path.sep)
  })
}

async function writeAudit(
  logPath: string,
  command: string,
  verdict: DangerousVerdict | undefined,
  action: string,
  gate: string,
  reason?: string,
) {
  try {
    const resolved = logPath.replace(/^~/, os.homedir())
    const line =
      JSON.stringify({
        timestamp: new Date().toISOString(),
        gate,
        command,
        build: BUILD_ID,
        verdict: verdict === undefined ? "safe" : verdict.kind,
        detail: verdict === undefined ? undefined : verdict.kind === "dangerous" ? verdict.command : verdict.kind,
        reason,
        action,
      }) + "\n"
    // Serialize per log path: rapid-fire asks must not interleave their
    // append writes out of submission order (audit ordering is relied on
    // for drift analysis).
    const write = async () => {
      const fs = await import("fs/promises")
      await fs.mkdir(path.dirname(resolved), { recursive: true })
      await fs.appendFile(resolved, line, "utf8")
    }
    const tail = (auditTails.get(resolved) ?? Promise.resolve()).then(
      write,
      write,
    )
    auditTails.set(resolved, tail.catch(() => {}))
    await tail
  } catch {
    // Auditing must never break the approval flow.
  }
}
