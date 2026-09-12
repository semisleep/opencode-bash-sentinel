import type { Plugin } from "@opencode-ai/plugin"
import os from "node:os"
import path from "node:path"
import {
  clearAlert,
  fireAlert,
  parseAlertOption,
  type AlertConfig,
} from "./alert"
import { analyzeCommandPolicy, type DangerousVerdict, type PolicyDecision, type PolicyGate } from "./policy-engine"
import {
  scratchMutationVerdict,
  sensitiveVerdict,
} from "./policy/path-domain"
import {
  defaultWorkspaceContext,
  hasGitSegment,
  stripTrailingSeparators,
  withinWorkspace,
} from "./workspace-policy"

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
   * System-prompt guidance for the agent (experimental engine hook):
   * unset/true = built-in text, string = custom text, false = off. Advisory
   * only — it never affects permission verdicts.
   */
  guidance?: boolean | string
}

const DEFAULT_LOG_PATH = "~/.local/share/opencode/bash-sentinel-audit.jsonl"

// Advisory nudge toward the analyzer's positive-recognition surface: the
// forms listed here are examples, not a catalogue claim, and the agent is
// told to prefer plain commands only when they are equally expressive.
const DEFAULT_GUIDANCE = `## Bash gate guidance (opencode-bash-sentinel)

A permission gate auto-approves only literal, statically recognizable Bash commands; anything else prompts the user and stalls your turn. To keep progress unattended:

- Prefer plain commands over ad-hoc scripts: rg/grep for search, ls/cat to inspect, cp/mv/mkdir/rm and git for workspace changes, npm/pip/cargo/go/make (or npx with a dependency declared in package.json) for builds and tests.
- Avoid shapes that always prompt: running a temporary script you just wrote, heredocs, pipes into interpreters (\`| sh\`, \`| python\`), and $VARS or $(cmd) wherever an argument names a path, a sed/awk-style script, or an option value. Send scratch output to the system temp dir (/tmp).
- Modify existing files with the edit tool, never scripted rewrites: \`python3 - <<EOF\` replace loops and \`perl -i\` one-liners always prompt, hide the exact change, and silently no-op when the needle doesn't match, while the edit tool shows a precise before/after and fails loudly on mismatch. sed -i is for mechanical renames across many files.
- When a command needs a computed value (line number, PID, file list), run the producer first, read its output, then rerun with the literal: \`sed -n "$(rg -n pattern f | cut -d: -f1)p" f\` prompts, while \`rg pattern f\` then \`sed -n 12p f\` runs unattended.
- One unrecognized segment escalates an entire \`&&\`/\`;\` line; split mixed lines so recognized parts do not wait on the rest.
- When a form prompts, restructure it into simpler commands instead of retrying cosmetic variations. Reserve scripts for logic that genuinely cannot be a few plain commands, and expect that prompt.`

const auditTails = new Map<string, Promise<void>>()

type AskedEvent = {
  id: string
  sessionID: string
  permission: string
  patterns?: string[]
  metadata?: {
    command?: unknown
    input?: { command?: unknown }
    filepath?: unknown
  }
}

export const BashSentinelPlugin: Plugin = async (input, options) => {
  const config = parseOptions(options)
  const workspace =
    input.worktree && input.worktree.length > 0 ? input.worktree : input.directory
  const scratchRoots =
    config.scratchPaths === undefined
      ? defaultScratchRoots(workspace)
      : config.scratchPaths === false
        ? []
        : config.scratchPaths
  const ctx = defaultWorkspaceContext(
    workspace,
    input.directory,
    config.sensitivePaths,
    scratchRoots,
  )

  void probeTransport(input, config)

  // Registered only while guidance is enabled: if the engine never calls the
  // experimental hook (renamed, removed, or a v2-only request path), the
  // guidance silently disappears - fail-open for an advisory feature. Hidden
  // agents (title, compaction) can request without a session and are skipped.
  const guidance = config.guidance
  return {
    ...(guidance !== undefined && {
      "experimental.chat.system.transform": async (
        { sessionID }: { sessionID?: string },
        output: { system: string[] },
      ) => {
        if (!sessionID) return
        output.system.push(guidance)
      },
    }),
    event: async ({ event }) => {
      // The published SDK types lag behind the server's event stream (the
      // server forwards every event as `{ id, type, properties }`), so widen
      // before switching on the type.
      const { type, properties } = event as { type: string; properties: unknown }
      if (type === "permission.replied") {
        if (config.alert) clearAlert(config.alert)
        return
      }
      if (type !== "permission.asked") return
      const request = properties as AskedEvent

      if (request.permission === "bash") return handleBash(request)
      if (request.permission === "external_directory") return handleExternal(request)
      if (request.permission === "edit") return handleEdit(request)
    },
  }

  async function handleBash(request: AskedEvent): Promise<void> {
    const command = readCommand(request)
    if (typeof command !== "string" || command.length === 0) return

    const decision = policyDecision(command, "bash")
    if (decision.action === "ask") {
      if (config.audit) void writeAudit(config.logPath, command, decision.verdict, "escalate", "bash", decision.reason)
      if (config.alert) fireAlert(config.alert)
      return
    }

    if (config.audit) void writeAudit(config.logPath, command, undefined, "approve", "bash")
    try {
      await replyOnce(request)
    } catch {
      // The human answered the native dialog first (or the server went
      // away): the request is already resolved and a late reply errors.
      // Fail-safe either way — dropping the reply leaves the dialog up.
    }
  }

  async function handleExternal(request: AskedEvent): Promise<void> {
    const command = readCommand(request)
    if (typeof command === "string" && command.length > 0) {
      const decision = policyDecision(command, "external_directory")
      if (decision.action === "ask") {
        if (config.audit) {
          void writeAudit(config.logPath, command, decision.verdict, "escalate", "external_directory", decision.reason)
        }
        if (config.alert) fireAlert(config.alert)
        return
      }

      if (config.audit) void writeAudit(config.logPath, command, undefined, "approve", "external_directory")
      try {
        await replyOnce(request)
      } catch {
        // Same race semantics as bash replies.
      }
      return
    }

    // ADR-0003: path-originated asks. Only the read-only tools (read, glob,
    // list) carry a concrete `metadata.filepath` (verified against opencode
    // 1.18.29); the edit family arrives with empty metadata and stays with
    // the native dialog so external writes keep asking at every gate.
    const filepath = readExternalPath(request)
    if (!filepath) {
      // Not a command ask and not a positively identified read-origin ask
      // (the edit family arrives with empty metadata). Left to the native
      // dialog, but audited with its metadata shape so engine drift away
      // from the verified 1.18.29 shapes stays visible in the log.
      if (config.audit) {
        const keys = Object.keys(request.metadata ?? {})
        void writeAudit(
          config.logPath,
          request.patterns?.join(" ") ?? "(no patterns)",
          { kind: "unanalyzable" },
          "escalate",
          "external_directory",
          `unclassified external ask shape: ${keys.length > 0 ? keys.join(",") : "no metadata"}`,
        )
      }
      return
    }
    const sensitive = !sensitiveVerdict(filepath, ctx).allow
    if (config.audit) {
      void writeAudit(
        config.logPath,
        filepath,
        sensitive ? { kind: "dangerous", command: "external read: sensitive path" } : undefined,
        sensitive ? "escalate" : "approve",
        "external_directory",
        sensitive ? "sensitive external read" : undefined,
      )
    }
    if (sensitive) {
      if (config.alert) fireAlert(config.alert)
      return
    }
    try {
      await replyOnce(request)
    } catch {
      // Same race semantics as bash replies.
    }
  }

  function readExternalPath(request: AskedEvent): string | undefined {
    const raw = request.metadata?.filepath
    if (typeof raw !== "string" || raw.length === 0) return
    if (/[*?[\]{}]/.test(raw)) return
    return path.resolve(ctx.workspace, raw)
  }

  async function handleEdit(request: AskedEvent): Promise<void> {
    const filepath = readFilepath(request)
    if (typeof filepath !== "string" || filepath.length === 0) return

    // ADR-0005: workspace containment is evaluated first (a workspace nested
    // under a scratch root keeps situation-1 semantics), the `.git` red line
    // is workspace-scoped, and external edits follow the shared mutation
    // rule with the sensitive red line evaluated first.
    const verdict: DangerousVerdict | undefined = withinWorkspace(
      filepath,
      ctx.workspace,
    )
      ? hasGitSegment(filepath) === true
        ? { kind: "dangerous", command: "edit: .git path" }
        : undefined
      : !sensitiveVerdict(filepath, ctx).allow
        ? { kind: "dangerous", command: "edit: sensitive path" }
        : scratchMutationVerdict(filepath, ctx).allow
          ? undefined
          : { kind: "dangerous", command: "edit: outside workspace" }

    if (config.audit) {
      void writeAudit(config.logPath, filepath, verdict, verdict === undefined ? "approve" : "escalate", "edit")
    }
    if (verdict !== undefined) {
      if (config.alert) fireAlert(config.alert)
      return
    }
    try {
      await replyOnce(request)
    } catch {
      // Same race semantics as bash replies.
    }
  }

  function policyDecision(command: string, gate: PolicyGate): PolicyDecision {
    return analyzeCommandPolicy(command, ctx, { gate })
  }

  async function replyOnce(request: AskedEvent): Promise<void> {
    // Transport order (each falls through to the next on absence/failure):
    //   1. client.permission.reply — newer SDKs expose the dedicated route
    //      (POST /permission/{requestID}/reply) and carry the in-process fetch
    //      fallback, which is required because `opencode run` embeds the
    //      server without an HTTP listener.
    //   2. client.postSessionIdPermissionsPermissionId — the deprecated
    //      session-scoped route (POST /session/{id}/permissions/{permissionID}),
    //      present in the v1 SDK shipped with opencode 1.x, same fallback.
    //   3./4. raw routes through the SDK client's own configured fetch
    //      (in-process in run mode) or global fetch (serve mode), new route
    //      first, then legacy — survives removal of either SDK method.
    const client = input.client as ReplyClient

    if (typeof client.permission?.reply === "function") {
      try {
        await client.permission.reply({ requestID: request.id, reply: "once" })
        return
      } catch {
        // Try the legacy SDK method and raw routes below.
      }
    }
    if (typeof client.postSessionIdPermissionsPermissionId === "function") {
      try {
        const result = await client.postSessionIdPermissionsPermissionId({
          path: { id: request.sessionID, permissionID: request.id },
          body: { response: "once" },
        })
        if (!result?.error) return
      } catch {
        // Try raw routes below.
      }
    }

    const base = input.serverUrl.href.replace(/\/$/, "")
    const init = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...authHeaders(),
      },
      body: JSON.stringify({ reply: "once" }),
    }

    const transport = clientFetch(input) ?? fetch
    const result = await transport(new Request(`${base}/permission/${encodeURIComponent(request.id)}/reply`, init))
    if (result.ok) return

    const legacy = await transport(
      new Request(
        `${base}/session/${encodeURIComponent(request.sessionID)}/permissions/${encodeURIComponent(request.id)}`,
        { ...init, body: JSON.stringify({ response: "once" }) },
      ),
    )
    if (!legacy.ok) {
      throw new Error(`permission reply failed: ${result.status}; legacy: ${legacy.status}`)
    }
  }

  function readFilepath(request: AskedEvent): unknown {
    const direct = request.metadata?.filepath
    if (typeof direct === "string" && direct.length > 0) return path.resolve(ctx.workspace, direct)
    const pattern = request.patterns?.[0]
    if (
      typeof pattern === "string" &&
      pattern.length > 0 &&
      !/[\\*?[\]{}]/.test(pattern)
    ) {
      return path.resolve(ctx.workspace, pattern)
    }
    return undefined
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
// symlink is not canonicalized — plus the host-process TMPDIR when set,
// absolute, and not covering a real tree. /var/tmp and /run/user are
// excluded: persistent or session state, not ephemeral by convention. Never
// read $TMPDIR at analysis time; the resolved value is fixed here, once per
// plugin context.
function defaultScratchRoots(workspace: string): string[] {
  const roots = new Set<string>(["/tmp"])
  if (process.platform === "darwin") roots.add("/private/tmp")
  const tmpdir = process.env.TMPDIR
  if (
    tmpdir &&
    path.isAbsolute(tmpdir) &&
    !coversRealTree(tmpdir, path.normalize(workspace))
  )
    roots.add(path.normalize(tmpdir))
  return [...roots]
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

function readCommand(request: AskedEvent): unknown {
  const direct = request.metadata?.command
  if (typeof direct === "string") return direct
  return request.metadata?.input?.command
}

type SdkResult = { error?: unknown }

type ReplyClient = {
  permission?: { reply?: (args: { requestID: string; reply: "once" }) => Promise<unknown> }
  postSessionIdPermissionsPermissionId?: (options: {
    path: { id: string; permissionID: string }
    body: { response: "once" }
  }) => Promise<SdkResult>
}

// The SDK client runs on a fetch that is in-process when opencode embeds the
// server (`opencode run` has no HTTP listener). Reusing it for raw routes
// keeps replies working even if both SDK reply methods disappear.
function clientFetch(input: Parameters<Plugin>[0]): typeof fetch | undefined {
  try {
    const inner = (input.client as unknown as {
      _client?: { getConfig?: () => { fetch?: unknown } }
    })._client
    const f = inner?.getConfig?.().fetch
    return typeof f === "function" ? (f as typeof fetch) : undefined
  } catch {
    return undefined
  }
}

// Startup health check: if no reply transport can reach the server, say so
// loudly instead of silently degrading into all-prompts mode.
async function probeTransport(
  input: Parameters<Plugin>[0],
  config: { audit: boolean; logPath: string },
): Promise<void> {
  const client = input.client as ReplyClient
  const hasSdkMethod =
    typeof client.permission?.reply === "function" ||
    typeof client.postSessionIdPermissionsPermissionId === "function"
  if (hasSdkMethod) return

  const base = input.serverUrl.href.replace(/\/$/, "")
  const transport = clientFetch(input) ?? fetch
  try {
    const response = await transport(new Request(`${base}/permission`))
    if (!response.ok && response.status !== 401 && response.status !== 404 && response.status !== 405) {
      throw new Error(`unexpected status ${response.status}`)
    }
  } catch (error) {
    const message = `[opencode-bash-sentinel] transport probe failed (${String(error)}) — auto-approval is disabled, every command will prompt. This plugin version is likely incompatible with this opencode version.`
    console.error(message)
    if (config.audit) {
      await writeAudit(config.logPath, "(transport probe)", { kind: "unanalyzable" }, "degraded", "transport")
    }
  }
}

function authHeaders(): Record<string, string> {
  const password = process.env.OPENCODE_SERVER_PASSWORD
  if (!password) return {}
  const username = process.env.OPENCODE_SERVER_USERNAME ?? "opencode"
  const token = Buffer.from(`${username}:${password}`).toString("base64")
  return { authorization: `Basic ${token}` }
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
      await fs.mkdir(dirname(resolved), { recursive: true })
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

function dirname(path: string): string {
  const index = path.lastIndexOf("/")
  if (index <= 0) return "."
  return path.slice(0, index)
}
