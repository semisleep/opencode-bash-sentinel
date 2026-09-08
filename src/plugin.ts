import type { Plugin } from "@opencode-ai/plugin"
import { analyzeCommandString, type DangerousVerdict } from "./analyzer"

export interface BashSentinelOptions {
  audit?: boolean
  logPath?: string
}

const DEFAULT_LOG_PATH = "~/.local/share/opencode/bash-sentinel-audit.jsonl"

type AskedEvent = {
  id: string
  sessionID: string
  permission: string
  metadata?: { command?: unknown; input?: { command?: unknown } }
}

export const BashSentinelPlugin: Plugin = async (input, options) => {
  const config = parseOptions(options)
  return {
    event: async ({ event }) => {
      // The published SDK types lag behind the server's event stream (the
      // server forwards every event as `{ id, type, properties }`), so widen
      // before switching on the type.
      const { type, properties } = event as { type: string; properties: unknown }
      if (type !== "permission.asked") return
      const request = properties as AskedEvent
      if (request.permission !== "bash") return
      const command = readCommand(request)
      if (typeof command !== "string" || command.length === 0) return

      const verdict = analyzeCommandString(command)
      const action = verdict === undefined ? "approve" : "escalate"
      if (config.audit) void writeAudit(config.logPath, command, verdict, action)
      if (verdict !== undefined) return

      try {
        await replyOnce(input, request)
      } catch {
        // The human answered the native dialog first (or the server went
        // away): the request is already resolved and a late reply errors.
        // Fail-safe either way — dropping the reply leaves the dialog up.
      }
    },
  }
}

function parseOptions(options: unknown): { audit: boolean; logPath: string } {
  const raw = (options ?? {}) as BashSentinelOptions
  return {
    audit: raw.audit === true,
    logPath: typeof raw.logPath === "string" && raw.logPath.length > 0 ? raw.logPath : DEFAULT_LOG_PATH,
  }
}

function readCommand(request: AskedEvent): unknown {
  const direct = request.metadata?.command
  if (typeof direct === "string") return direct
  return request.metadata?.input?.command
}

type SdkResult = { error?: unknown }

async function replyOnce(input: Parameters<Plugin>[0], request: AskedEvent): Promise<void> {
  // Transport order (each falls through to the next on absence/failure):
  //   1. client.permission.reply — newer SDKs expose the dedicated route
  //      (POST /permission/{requestID}/reply) and carry the in-process fetch
  //      fallback, which is required because `opencode run` embeds the
  //      server without an HTTP listener.
  //   2. client.postSessionIdPermissionsPermissionId — the deprecated
  //      session-scoped route (POST /session/{id}/permissions/{permissionID}),
  //      present in the v1 SDK shipped with opencode 1.x, same fallback.
  //   3./4. raw fetch against serverUrl for standalone `opencode serve`
  //      setups (new route, then legacy) with basic auth when configured.
  const client = input.client as {
    permission?: { reply?: (args: { requestID: string; reply: "once" }) => Promise<unknown> }
    postSessionIdPermissionsPermissionId?: (options: {
      path: { id: string; permissionID: string }
      body: { response: "once" }
    }) => Promise<SdkResult>
  }

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

  const result = await fetch(`${base}/permission/${encodeURIComponent(request.id)}/reply`, init)
  if (result.ok) return

  const legacy = await fetch(
    `${base}/session/${encodeURIComponent(request.sessionID)}/permissions/${encodeURIComponent(request.id)}`,
    { ...init, body: JSON.stringify({ response: "once" }) },
  )
  if (!legacy.ok) {
    throw new Error(`permission reply failed: ${result.status}; legacy: ${legacy.status}`)
  }
}

function authHeaders(): Record<string, string> {
  const password = process.env.OPENCODE_SERVER_PASSWORD
  if (!password) return {}
  const username = process.env.OPENCODE_SERVER_USERNAME ?? "opencode"
  const token = Buffer.from(`${username}:${password}`).toString("base64")
  return { authorization: `Basic ${token}` }
}

async function writeAudit(logPath: string, command: string, verdict: DangerousVerdict | undefined, action: string) {
  try {
    const { default: os } = await import("os")
    const path = logPath.replace(/^~/, os.homedir())
    const line =
      JSON.stringify({
        timestamp: new Date().toISOString(),
        command,
        verdict: verdict === undefined ? "safe" : verdict.kind,
        action,
      }) + "\n"
    const fs = await import("fs/promises")
    await fs.mkdir(dirname(path), { recursive: true })
    await fs.appendFile(path, line, "utf8")
  } catch {
    // Auditing must never break the approval flow.
  }
}

function dirname(path: string): string {
  const index = path.lastIndexOf("/")
  if (index <= 0) return "."
  return path.slice(0, index)
}
