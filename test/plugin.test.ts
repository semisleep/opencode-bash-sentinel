import { afterEach, describe, expect, it, vi } from "vitest"
import { BashSentinelPlugin } from "../src/plugin"
import type { Plugin } from "@opencode-ai/plugin"

type FetchMock = ReturnType<typeof vi.fn>

const serverUrl = new URL("http://sentinel-test.local/")

function askedEvent(overrides: Record<string, unknown> = {}) {
  return {
    type: "permission.asked",
    properties: {
      id: "per_123",
      sessionID: "ses_456",
      permission: "bash",
      metadata: { command: "git status" },
      ...overrides,
    },
  }
}

function makeInput(client: unknown = {}) {
  return { client, serverUrl } as Parameters<Plugin>[0]
}

async function emit(plugin: Plugin, event: unknown) {
  const hooks = await plugin(makeInput(), undefined)
  await hooks.event!({ event } as never)
}

let fetchMock: FetchMock

function ok() {
  return { ok: true, status: 200 } as Response
}

function notFound() {
  return { ok: false, status: 404 } as Response
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("approval decisions", () => {
  it("safe command replies once via the dedicated permission route", async () => {
    fetchMock = vi.fn().mockResolvedValue(ok())
    vi.stubGlobal("fetch", fetchMock)

    await emit(BashSentinelPlugin, askedEvent())

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe("http://sentinel-test.local/permission/per_123/reply")
    expect(init.method).toBe("POST")
    expect(JSON.parse(init.body)).toEqual({ reply: "once" })
  })

  it("dangerous command never replies", async () => {
    fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    await emit(BashSentinelPlugin, askedEvent({ metadata: { command: "sudo rm -rf /" } }))

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("unanalyzable command never replies", async () => {
    fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    await emit(BashSentinelPlugin, askedEvent({ metadata: { command: "$CMD --force" } }))

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("non-bash permissions are ignored", async () => {
    fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    await emit(BashSentinelPlugin, askedEvent({ permission: "edit" }))
    await emit(BashSentinelPlugin, { type: "permission.replied", properties: {} })

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("missing or non-string command is ignored", async () => {
    fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    await emit(BashSentinelPlugin, askedEvent({ metadata: {} }))
    await emit(BashSentinelPlugin, askedEvent({ metadata: { command: 42 } }))

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("reads command from metadata.input.command as a legacy fallback", async () => {
    fetchMock = vi.fn().mockResolvedValue(ok())
    vi.stubGlobal("fetch", fetchMock)

    await emit(BashSentinelPlugin, askedEvent({ metadata: { input: { command: "ls -la" } } }))

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe("reply transport", () => {
  it("prefers client.permission.reply when the SDK exposes it", async () => {
    const reply = vi.fn().mockResolvedValue(undefined)
    fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    await emit(BashSentinelPlugin, askedEvent())
    // default input has no client.permission.reply — sanity: fetch used
    expect(fetchMock).toHaveBeenCalledTimes(1)

    fetchMock.mockClear()
    const plugin = BashSentinelPlugin
    const hooks = await plugin(makeInput({ permission: { reply } }), undefined)
    await hooks.event!({ event: askedEvent() } as never)

    expect(reply).toHaveBeenCalledWith({ requestID: "per_123", reply: "once" })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("falls back to the legacy session route when the dedicated route fails", async () => {
    fetchMock = vi.fn().mockResolvedValueOnce(notFound()).mockResolvedValueOnce(ok())
    vi.stubGlobal("fetch", fetchMock)

    await emit(BashSentinelPlugin, askedEvent())

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1]![0]).toBe(
      "http://sentinel-test.local/session/ses_456/permissions/per_123",
    )
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body)).toEqual({ response: "once" })
  })

  it("swallows errors when the human answered first (both routes fail)", async () => {
    fetchMock = vi.fn().mockResolvedValue(notFound())
    vi.stubGlobal("fetch", fetchMock)

    await expect(emit(BashSentinelPlugin, askedEvent())).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("attaches basic auth when OPENCODE_SERVER_PASSWORD is set", async () => {
    fetchMock = vi.fn().mockResolvedValue(ok())
    vi.stubGlobal("fetch", fetchMock)
    vi.stubEnv("OPENCODE_SERVER_PASSWORD", "s3cret")

    try {
      await emit(BashSentinelPlugin, askedEvent())

      const headers = fetchMock.mock.calls[0]![1].headers
      const expected = Buffer.from("opencode:s3cret").toString("base64")
      expect(headers.authorization).toBe(`Basic ${expected}`)
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe("audit log", () => {
  it("appends one JSONL line per decision when enabled", async () => {
    const os = await import("os")
    const path = await import("path")
    const fs = await import("fs/promises")
    const logPath = path.join(os.tmpdir(), `sentinel-test-${process.pid}-${Date.now()}.jsonl`)

    fetchMock = vi.fn().mockResolvedValue(ok())
    vi.stubGlobal("fetch", fetchMock)

    const plugin = BashSentinelPlugin
    const hooks = await plugin(makeInput(), { audit: true, logPath })
    await hooks.event!({ event: askedEvent() } as never)
    await hooks.event!({ event: askedEvent({ metadata: { command: "rm -rf /" } }) } as never)
    await new Promise((resolve) => setTimeout(resolve, 50))

    const lines = (await fs.readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
    expect(lines).toHaveLength(2)
    expect(lines).toContainEqual(
      expect.objectContaining({ command: "git status", verdict: "safe", action: "approve" }),
    )
    expect(lines).toContainEqual(
      expect.objectContaining({ command: "rm -rf /", verdict: "dangerous", action: "escalate" }),
    )
    await fs.rm(logPath)
  })

  it("does not write anything by default", async () => {
    const os = await import("os")
    const path = await import("path")
    const fs = await import("fs/promises")
    const logPath = path.join(os.tmpdir(), `sentinel-default-${process.pid}-${Date.now()}.jsonl`)

    fetchMock = vi.fn().mockResolvedValue(ok())
    vi.stubGlobal("fetch", fetchMock)

    const hooks = await BashSentinelPlugin(makeInput(), { logPath })
    await hooks.event!({ event: askedEvent() } as never)
    await new Promise((resolve) => setTimeout(resolve, 50))

    await expect(fs.access(logPath)).rejects.toThrow()
  })
})
