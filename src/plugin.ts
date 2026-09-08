import type { Plugin } from "@opencode-ai/plugin"
import os from "node:os"
import path from "node:path"
import { analyzeCommandString, type DangerousVerdict } from "./analyzer"
import { analyzeWorkspacePolicy, defaultWorkspaceContext, hasGitSegment, withinWorkspace } from "./workspace-policy"

export interface BashSentinelOptions {
  audit?: boolean
  logPath?: string
  /** Revert to the verbatim upstream Kimi policy (workspace path rules disabled). */
  upstream?: boolean
}

const DEFAULT_LOG_PATH = "~/.local/share/opencode/bash-sentinel-audit.jsonl"

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
  const ctx = defaultWorkspaceContext(workspace)

  void probeTransport(input, config)

  return {
    event: async ({ event }) => {
      // The published SDK types lag behind the server's event stream (the
      // server forwards every event as `{ id, type, properties }`), so widen
      // before switching on the type.
      const { type, properties } = event as { type: string; properties: unknown }
      if (type !== "permission.asked") return
      const request = properties as AskedEvent

      if (request.permission === "bash") return handleBash(request)
      if (request.permission === "external_directory" && !config.upstream) return handleExternal(request)
      if (request.permission === "edit" && !config.upstream) return handleEdit(request)
    },
  }

  async function handleBash(request: AskedEvent): Promise<void> {
    const command = readCommand(request)
    if (typeof command !== "string" || command.length === 0) return

    const verdict = policyVerdict(command)
    if (verdict !== undefined) {
      if (config.audit) void writeAudit(config.logPath, command, verdict, "escalate", "bash")
      return
    }

    if (config.audit) void writeAudit(config.logPath, command, verdict, "approve", "bash")
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
    if (typeof command !== "string" || command.length === 0) return

    const verdict = policyVerdict(command)
    if (verdict !== undefined) {
      if (config.audit) void writeAudit(config.logPath, command, verdict, "escalate", "external_directory")
      return
    }

    if (config.audit) void writeAudit(config.logPath, command, verdict, "approve", "external_directory")
    try {
      await replyOnce(request)
    } catch {
      // Same race semantics as bash replies.
    }
  }

  async function handleEdit(request: AskedEvent): Promise<void> {
    const filepath = readFilepath(request)
    if (typeof filepath !== "string" || filepath.length === 0) return

    const verdict: DangerousVerdict | undefined =
      hasGitSegment(filepath) === true
        ? { kind: "dangerous", command: "edit: .git path" }
        : withinWorkspace(filepath, ctx.workspace)
          ? undefined
          : { kind: "dangerous", command: "edit: outside workspace" }

    if (config.audit) {
      void writeAudit(config.logPath, filepath, verdict, verdict === undefined ? "approve" : "escalate", "edit")
    }
    if (verdict !== undefined) return
    try {
      await replyOnce(request)
    } catch {
      // Same race semantics as bash replies.
    }
  }

  function policyVerdict(command: string): DangerousVerdict | undefined {
    const upstream = analyzeCommandString(command)
    if (config.upstream) return upstream
    const result = analyzeWorkspacePolicy(command, ctx)
    if (result.verdict !== undefined) return result.verdict
    if (result.rmHandled && upstream?.kind === "dangerous" && upstream.command === "rm -rf") return undefined
    return upstream
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
      await client.permission.reply({ requestID: request.id, reply: "once" })
      return
    }
    if (typeof client.postSessionIdPermissionsPermissionId === "function") {
      const result = await client.postSessionIdPermissionsPermissionId({
        path: { id: request.sessionID, permissionID: request.id },
        body: { response: "once" },
      })
      if (!result?.error) return
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
    if (typeof pattern === "string") return path.resolve(ctx.workspace, pattern)
    return undefined
  }
}

function parseOptions(options: unknown): { audit: boolean; logPath: string; upstream: boolean } {
  const raw = (options ?? {}) as BashSentinelOptions
  return {
    audit: raw.audit === true,
    logPath: typeof raw.logPath === "string" && raw.logPath.length > 0 ? raw.logPath : DEFAULT_LOG_PATH,
    upstream: raw.upstream === true,
  }
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
        action,
      }) + "\n"
    const fs = await import("fs/promises")
    await fs.mkdir(dirname(resolved), { recursive: true })
    await fs.appendFile(resolved, line, "utf8")
  } catch {
    // Auditing must never break the approval flow.
  }
}

function dirname(path: string): string {
  const index = path.lastIndexOf("/")
  if (index <= 0) return "."
  return path.slice(0, index)
}
