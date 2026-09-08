import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { BashSentinelPlugin } from "../src/plugin"
import type { Plugin, PluginInput } from "@opencode-ai/plugin"

type FetchMock = ReturnType<typeof vi.fn>

const WORKSPACE = "/Users/dev/project"

function makeInput(overrides: Partial<Record<keyof PluginInput, unknown>> = {}) {
  return {
    client: {},
    directory: WORKSPACE,
    worktree: WORKSPACE,
    serverUrl: new URL("http://sentinel-test.local/"),
    ...overrides,
  } as unknown as Parameters<Plugin>[0]
}

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

async function emit(hooks: Awaited<ReturnType<Plugin>>, event: unknown) {
  await hooks.event!({ event } as never)
}

let fetchMock: FetchMock

function ok() {
  return { ok: true, status: 200 } as Response
}

function notFound() {
  return { ok: false, status: 404 } as Response
}

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue(ok())
  vi.stubGlobal("fetch", fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

async function makePlugin(options?: Record<string, unknown>) {
  const hooks = await BashSentinelPlugin(makeInput(), options)
  // the startup transport probe may use the stubbed fetch; let it settle and
  // start counting from zero
  await new Promise((resolve) => setTimeout(resolve, 10))
  fetchMock.mockClear()
  return hooks
}

describe("bash gate", () => {
  it("safe command is approved via the legacy SDK route", async () => {
    const legacyReply = vi.fn().mockResolvedValue({ error: undefined })
    const hooks = await BashSentinelPlugin(
      makeInput({ client: { postSessionIdPermissionsPermissionId: legacyReply } }),
      undefined,
    )
    await emit(hooks, askedEvent())

    expect(legacyReply).toHaveBeenCalledWith({
      path: { id: "ses_456", permissionID: "per_123" },
      body: { response: "once" },
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("writes outside the workspace escalate (no reply)", async () => {
    const legacyReply = vi.fn()
    const hooks = await BashSentinelPlugin(
      makeInput({ client: { postSessionIdPermissionsPermissionId: legacyReply } }),
      undefined,
    )
    await emit(hooks, askedEvent({ metadata: { command: "echo x > /tmp/out" } }))
    await emit(hooks, askedEvent({ metadata: { command: "rm ~/.zshrc" } }))
    await emit(hooks, askedEvent({ metadata: { command: "sed -i s/a/b/ /etc/hosts" } }))
    await emit(hooks, askedEvent({ metadata: { command: "python -c 'x'" } }))

    expect(legacyReply).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("in-workspace rm -rf is approved (upstream verdict suppressed)", async () => {
    const legacyReply = vi.fn().mockResolvedValue({ error: undefined })
    const hooks = await BashSentinelPlugin(
      makeInput({ client: { postSessionIdPermissionsPermissionId: legacyReply } }),
      undefined,
    )
    await emit(hooks, askedEvent({ metadata: { command: "rm -rf build" } }))
    expect(legacyReply).toHaveBeenCalledTimes(1)
  })

  it("upstream dangerous commands still escalate", async () => {
    const hooks = await makePlugin()
    await emit(hooks, askedEvent({ metadata: { command: "sudo shutdown" } }))
    await emit(hooks, askedEvent({ metadata: { command: "dd if=x of=/dev/sda" } }))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("upstream:true reverts to verbatim Kimi semantics", async () => {
    const hooks = await makePlugin({ upstream: true })
    // outside-write is invisible to the upstream analyzer: must be approved
    await emit(hooks, askedEvent({ metadata: { command: "echo x > /tmp/out" } }))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // rm -rf anywhere stays dangerous upstream: must escalate
    fetchMock.mockClear()
    await emit(hooks, askedEvent({ metadata: { command: "rm -rf build" } }))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("missing or non-string command is ignored", async () => {
    const hooks = await makePlugin()
    await emit(hooks, askedEvent({ metadata: {} }))
    await emit(hooks, askedEvent({ metadata: { command: 42 } }))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("reads command from metadata.input.command as a legacy fallback", async () => {
    const hooks = await makePlugin()
    await emit(hooks, askedEvent({ metadata: { input: { command: "ls -la" } } }))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("reply failure is swallowed (human answered first)", async () => {
    fetchMock.mockResolvedValue(notFound())
    const hooks = await makePlugin()
    await expect(emit(hooks, askedEvent())).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(2) // new route + legacy route
  })

  it("basic auth header is attached when OPENCODE_SERVER_PASSWORD is set", async () => {
    vi.stubEnv("OPENCODE_SERVER_PASSWORD", "s3cret")
    const hooks = await makePlugin()
    await emit(hooks, askedEvent())

    const request = fetchMock.mock.calls[0]![0] as Request
    const expected = Buffer.from("opencode:s3cret").toString("base64")
    expect(request.headers.get("authorization")).toBe(`Basic ${expected}`)
  })
})

describe("external_directory gate", () => {
  it("read-only external commands are approved", async () => {
    const hooks = await makePlugin()
    await emit(hooks, askedEvent({ permission: "external_directory", metadata: { command: "cat /etc/hosts" } }))
    await emit(hooks, askedEvent({ permission: "external_directory", metadata: { command: "cd /tmp && ls" } }))
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("external writes escalate and are remembered for the bash follow-up", async () => {
    const hooks = await makePlugin()
    // 1. external ask for rm /tmp/x: policy says dangerous → no reply
    await emit(hooks, askedEvent({ permission: "external_directory", metadata: { command: "rm /tmp/x" } }))
    expect(fetchMock).not.toHaveBeenCalled()
    // 2. bash ask for the same command only happens after the human approved
    //    the dialog → not asked twice
    await emit(hooks, askedEvent({ metadata: { command: "rm /tmp/x" } }))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("external read + in-workspace write is approved", async () => {
    const hooks = await makePlugin()
    await emit(
      hooks,
      askedEvent({ permission: "external_directory", metadata: { command: "cat /etc/hosts > out.txt" } }),
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("not handled in upstream mode", async () => {
    const hooks = await makePlugin({ upstream: true })
    await emit(hooks, askedEvent({ permission: "external_directory", metadata: { command: "cat /etc/hosts" } }))
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe("edit gate", () => {
  it("in-workspace edits are approved", async () => {
    const hooks = await makePlugin()
    await emit(
      hooks,
      askedEvent({ permission: "edit", metadata: { filepath: `${WORKSPACE}/src/app.ts` } }),
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it(".git paths escalate", async () => {
    const hooks = await makePlugin()
    await emit(
      hooks,
      askedEvent({ permission: "edit", metadata: { filepath: `${WORKSPACE}/.git/config` } }),
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("outside-workspace edits escalate", async () => {
    const hooks = await makePlugin()
    await emit(hooks, askedEvent({ permission: "edit", metadata: { filepath: "/etc/hosts" } }))
    await emit(hooks, askedEvent({ permission: "edit", metadata: { filepath: "/Users/dev/.zshrc" } }))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("relative pattern fallback resolves against the workspace", async () => {
    const hooks = await makePlugin()
    await emit(hooks, askedEvent({ permission: "edit", patterns: ["src/app.ts"], metadata: {} }))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    fetchMock.mockClear()
    await emit(hooks, askedEvent({ permission: "edit", patterns: ["../../outside.txt"], metadata: {} }))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("not handled in upstream mode", async () => {
    const hooks = await makePlugin({ upstream: true })
    await emit(
      hooks,
      askedEvent({ permission: "edit", metadata: { filepath: `${WORKSPACE}/src/app.ts` } }),
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe("other events are ignored", () => {
  it("non-permission and non-bash events never reply", async () => {
    const hooks = await makePlugin()
    await emit(hooks, { type: "session.created", properties: {} })
    await emit(hooks, { type: "permission.replied", properties: {} })
    await emit(hooks, askedEvent({ permission: "webfetch" }))
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe("audit log", () => {
  it("appends one JSONL line per decision when enabled", async () => {
    const os = await import("os")
    const path = await import("path")
    const fs = await import("fs/promises")
    const logPath = path.join(os.tmpdir(), `sentinel-test-${process.pid}-${Date.now()}.jsonl`)

    const hooks = await makePlugin({ audit: true, logPath })
    await emit(hooks, askedEvent())
    await emit(hooks, askedEvent({ metadata: { command: "rm -rf /tmp/x" } }))
    await new Promise((resolve) => setTimeout(resolve, 50))

    const lines = (await fs.readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
    expect(lines).toHaveLength(2)
    expect(lines).toContainEqual(
      expect.objectContaining({ gate: "bash", command: "git status", verdict: "safe", action: "approve" }),
    )
    expect(lines).toContainEqual(
      expect.objectContaining({ gate: "bash", command: "rm -rf /tmp/x", verdict: "dangerous", action: "escalate" }),
    )
    await fs.rm(logPath)
  })

  it("does not write anything by default", async () => {
    const os = await import("os")
    const path = await import("path")
    const fs = await import("fs/promises")
    const logPath = path.join(os.tmpdir(), `sentinel-default-${process.pid}-${Date.now()}.jsonl`)

    const hooks = await makePlugin({ logPath })
    await emit(hooks, askedEvent())
    await new Promise((resolve) => setTimeout(resolve, 50))

    await expect(fs.access(logPath)).rejects.toThrow()
  })
})
