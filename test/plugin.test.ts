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

  it("falls through when a newer SDK reply method fails", async () => {
    const modernReply = vi.fn().mockRejectedValue(new Error("unsupported route"))
    const legacyReply = vi.fn().mockResolvedValue({ error: undefined })
    const hooks = await BashSentinelPlugin(
      makeInput({
        client: {
          permission: { reply: modernReply },
          postSessionIdPermissionsPermissionId: legacyReply,
        },
      }),
      undefined,
    )
    await emit(hooks, askedEvent())

    expect(modernReply).toHaveBeenCalledTimes(1)
    expect(legacyReply).toHaveBeenCalledTimes(1)
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

  it("workspace-root and relative-escape writes are not approved", async () => {
    const legacyReply = vi.fn()
    const hooks = await BashSentinelPlugin(
      makeInput({ client: { postSessionIdPermissionsPermissionId: legacyReply } }),
      undefined,
    )
    await emit(hooks, askedEvent({ metadata: { command: "rm -rf ." } }))
    await emit(hooks, askedEvent({ metadata: { command: "echo x > ../outside" } }))
    expect(legacyReply).not.toHaveBeenCalled()
  })

  it("upstream dangerous commands still escalate", async () => {
    const hooks = await makePlugin()
    await emit(hooks, askedEvent({ metadata: { command: "sudo shutdown" } }))
    await emit(hooks, askedEvent({ metadata: { command: "dd if=x of=/dev/sda" } }))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("unknown commands and untrusted executable paths fail closed", async () => {
    const hooks = await makePlugin()
    for (const command of [
      "totally-unknown-command --flag",
      "curl -o /tmp/out https://example.invalid/x",
      "git push",
      "find . -fprint /tmp/out",
      "rsync src/ dest/ --log-file=/tmp/log",
      "/tmp/ls -la",
      "FOO=bar echo ok",
      "python -W ignore /tmp/evil.py",
      "install -d /tmp/external local-dir",
      "printf -v PATH /tmp; ls",
      "printf x | xargs file --compile -m /tmp/magic",
      "node --require local-helper server.js",
    ]) {
      await emit(hooks, askedEvent({ metadata: { command } }))
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("retains the documented workspace-script and developer-tool trust boundaries", async () => {
    const hooks = await makePlugin()
    for (const command of ["npm test", "make test", "python script.py", "bash scripts/build.sh", "./scripts/check"] ) {
      await emit(hooks, askedEvent({ metadata: { command } }))
    }
    expect(fetchMock).toHaveBeenCalledTimes(5)
  })

  it("the removed upstream option can no longer disable fail-closed policy", async () => {
    const hooks = await makePlugin({ upstream: true })
    await emit(hooks, askedEvent({ metadata: { command: "echo x > /tmp/out" } }))
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

  it("external and bash permissions remain independent for dangerous commands", async () => {
    const hooks = await makePlugin()
    // 1. external ask for rm /tmp/x: policy says dangerous → no reply
    await emit(hooks, askedEvent({ permission: "external_directory", metadata: { command: "rm /tmp/x" } }))
    expect(fetchMock).not.toHaveBeenCalled()
    // 2. Approval of directory access is not treated as approval of the
    //    command's separate bash risk, so the follow-up also stays with the human.
    await emit(hooks, askedEvent({ metadata: { command: "rm /tmp/x" } }))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("external read + in-workspace write is approved", async () => {
    const hooks = await makePlugin()
    await emit(
      hooks,
      askedEvent({ permission: "external_directory", metadata: { command: "cat /etc/hosts > out.txt" } }),
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("does not auto-approve external paths for unmodeled commands", async () => {
    const hooks = await makePlugin()
    for (const command of [
      "curl -o /tmp/out https://example.invalid/x",
      "tar -xf archive.tar -C /tmp",
      "cpio -id --directory=/tmp < archive.cpio",
      "git clone https://example.invalid/repo /tmp/repo",
      `awk -v out=/tmp/x 'BEGIN { print 1 > out }'`,
    ]) {
      await emit(hooks, askedEvent({ permission: "external_directory", metadata: { command } }))
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("still approves modeled external reads with internal writes", async () => {
    const hooks = await makePlugin()
    await emit(
      hooks,
      askedEvent({ permission: "external_directory", metadata: { command: "cp /etc/hosts local-copy" } }),
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("the removed upstream option cannot bypass this gate", async () => {
    const hooks = await makePlugin({ upstream: true })
    await emit(hooks, askedEvent({ permission: "external_directory", metadata: { command: "cat /etc/hosts" } }))
    expect(fetchMock).toHaveBeenCalledTimes(1)
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

  it("the removed upstream option cannot bypass this gate", async () => {
    const hooks = await makePlugin({ upstream: true })
    await emit(
      hooks,
      askedEvent({ permission: "edit", metadata: { filepath: `${WORKSPACE}/src/app.ts` } }),
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
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
