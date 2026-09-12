import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { BashSentinelPlugin } from "../src/plugin"
import { analyzeWorkspacePolicy } from "../src/workspace-policy"
import { BUILD_ID } from "../src/version"
import type { Plugin, PluginInput } from "@opencode-ai/plugin"
import { clearAlert, fireAlert } from "../src/alert"
import { execFileSync } from "node:child_process"
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import os from "node:os"
import path from "node:path"

vi.mock("../src/alert", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/alert")>()
  return { ...actual, fireAlert: vi.fn(), clearAlert: vi.fn() }
})

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
    await emit(hooks, askedEvent({ metadata: { command: "echo x > /etc/out" } }))
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

  it("does not approve scripts or workflows when their Git baseline cannot be verified", async () => {
    const hooks = await makePlugin()
    for (const command of ["npm test", "make test", "python script.py", "bash scripts/build.sh", "./scripts/check"] ) {
      await emit(hooks, askedEvent({ metadata: { command } }))
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("resolves relative commands from directory rather than the worktree root", async () => {
    const worktree = mkdtempSync(path.join(os.tmpdir(), "sentinel-cwd-"))
    const directory = path.join(worktree, "sub")
    mkdirSync(directory)
    try {
      writeFileSync(path.join(worktree, "check.sh"), "#!/bin/sh\ntrue\n")
      writeFileSync(path.join(directory, "check.sh"), "#!/bin/sh\ntrue\n")
      execFileSync("git", ["init", "-q", worktree])
      execFileSync("git", ["-C", worktree, "add", "."])
      execFileSync("git", [
        "-C",
        worktree,
        "-c",
        "user.name=Sentinel Test",
        "-c",
        "user.email=sentinel@example.invalid",
        "commit",
        "-qm",
        "baseline",
      ])
      appendFileSync(path.join(directory, "check.sh"), "echo changed\n")

      const legacyReply = vi.fn()
      const hooks = await BashSentinelPlugin(
        makeInput({
          worktree,
          directory,
          client: { postSessionIdPermissionsPermissionId: legacyReply },
        }),
        undefined,
      )
      await emit(hooks, askedEvent({ metadata: { command: "./check.sh" } }))
      expect(legacyReply).not.toHaveBeenCalled()
    } finally {
      rmSync(worktree, { recursive: true, force: true })
    }
  })

  it("the removed upstream option can no longer disable fail-closed policy", async () => {
    const hooks = await makePlugin({ upstream: true })
    await emit(hooks, askedEvent({ metadata: { command: "echo x > /etc/out" } }))
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
    // 1. external ask for rm /etc/x: policy says dangerous → no reply
    await emit(hooks, askedEvent({ permission: "external_directory", metadata: { command: "rm /etc/x" } }))
    expect(fetchMock).not.toHaveBeenCalled()
    // 2. Approval of directory access is not treated as approval of the
    //    command's separate bash risk, so the follow-up also stays with the human.
    await emit(hooks, askedEvent({ metadata: { command: "rm /etc/x" } }))
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

  it("uses the whole-unit outside classification for mixed read/write commands", async () => {
    const hooks = await makePlugin()
    await emit(
      hooks,
      askedEvent({ permission: "external_directory", metadata: { command: "cp /etc/hosts local-copy" } }),
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("the removed upstream option cannot bypass this gate", async () => {
    const hooks = await makePlugin({ upstream: true })
    await emit(hooks, askedEvent({ permission: "external_directory", metadata: { command: "cat /etc/hosts" } }))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("path-originated read asks follow the outside-workspace read rule (ADR-0003)", async () => {
    const hooks = await makePlugin()
    const home = os.homedir()
    // read-tool ask, external non-sensitive -> approve
    await emit(
      hooks,
      askedEvent({ permission: "external_directory", metadata: { filepath: "/etc/hosts", parentDir: "/etc" } }),
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
    fetchMock.mockClear()
    // glob-tool ask, directory-shaped external non-sensitive -> approve
    await emit(
      hooks,
      askedEvent({ permission: "external_directory", metadata: { filepath: "/tmp", parentDir: "/tmp" } }),
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
    fetchMock.mockClear()
    // sensitive read -> stays with the human
    await emit(
      hooks,
      askedEvent({
        permission: "external_directory",
        metadata: { filepath: path.join(home, ".ssh", "id_rsa") },
      }),
    )
    // glob metacharacters -> unresolvable, stays with the human
    await emit(
      hooks,
      askedEvent({ permission: "external_directory", metadata: { filepath: "/etc/*" } }),
    )
    // edit-family ask (empty metadata) -> external writes keep asking
    await emit(hooks, askedEvent({ permission: "external_directory", metadata: {} }))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("audits unanswered external asks with their metadata shape for drift visibility", async () => {
    const logPath = path.join(
      os.tmpdir(),
      `sentinel-shape-${process.pid}-${Date.now()}.jsonl`,
    )
    const hooks = await makePlugin({ audit: true, logPath })
    await emit(
      hooks,
      askedEvent({
        permission: "external_directory",
        patterns: ["/etc/*"],
        metadata: { filepath: "/etc/*" },
      }),
    )
    await emit(
      hooks,
      askedEvent({
        permission: "external_directory",
        patterns: ["/Users/dev/*.zshrc/*"],
        metadata: {},
      }),
    )
    await new Promise((resolve) => setTimeout(resolve, 50))

    const fs = await import("fs/promises")
    const lines = (await fs.readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({
      action: "escalate",
      reason: "unclassified external ask shape: filepath",
      command: "/etc/*",
    })
    expect(lines[1]).toMatchObject({
      action: "escalate",
      reason: "unclassified external ask shape: no metadata",
      command: "/Users/dev/*.zshrc/*",
    })
    await fs.rm(logPath)
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

  it("does not treat glob patterns as concrete edit paths", async () => {
    const hooks = await makePlugin()
    await emit(hooks, askedEvent({ permission: "edit", patterns: ["**"], metadata: {} }))
    await emit(hooks, askedEvent({ permission: "edit", patterns: ["{src,.git}/**"], metadata: {} }))
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

  it("scratch descendants approve and the root itself escalates (ADR-0005)", async () => {
    const hooks = await makePlugin()
    await emit(
      hooks,
      askedEvent({ permission: "edit", metadata: { filepath: "/tmp/sentinel-probe.ts" } }),
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
    fetchMock.mockClear()
    await emit(
      hooks,
      askedEvent({ permission: "edit", metadata: { filepath: "/tmp" } }),
    )
    await emit(
      hooks,
      askedEvent({ permission: "edit", metadata: { filepath: "/etc/hosts" } }),
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("scratch .git paths approve while workspace .git still escalates", async () => {
    const hooks = await makePlugin()
    await emit(
      hooks,
      askedEvent({ permission: "edit", metadata: { filepath: "/tmp/checkout/.git/config" } }),
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
    fetchMock.mockClear()
    await emit(
      hooks,
      askedEvent({ permission: "edit", metadata: { filepath: `${WORKSPACE}/.git/config` } }),
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("sensitive external edits escalate even under a scratch root", async () => {
    const hooks = await makePlugin({ sensitivePaths: ["/srv/secret"], scratchPaths: ["/srv"] })
    await emit(
      hooks,
      askedEvent({ permission: "edit", metadata: { filepath: "/srv/secret/key" } }),
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("scratchPaths: false restores the pre-ADR-0005 edit gate", async () => {
    const hooks = await makePlugin({ scratchPaths: false })
    await emit(
      hooks,
      askedEvent({ permission: "edit", metadata: { filepath: "/tmp/sentinel-probe.ts" } }),
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("audit lines pin the edit-gate reason strings", async () => {
    const logPath = path.join(
      os.tmpdir(),
      `sentinel-edit-${process.pid}-${Date.now()}.jsonl`,
    )
    const hooks = await makePlugin({
      audit: true,
      logPath,
      sensitivePaths: ["/srv/secret"],
    })
    await emit(
      hooks,
      askedEvent({ permission: "edit", metadata: { filepath: "/tmp/sentinel-probe.ts" } }),
    )
    await emit(
      hooks,
      askedEvent({ permission: "edit", metadata: { filepath: "/tmp/co/.git/config" } }),
    )
    await emit(
      hooks,
      askedEvent({ permission: "edit", metadata: { filepath: `${WORKSPACE}/.git/config` } }),
    )
    await emit(
      hooks,
      askedEvent({ permission: "edit", metadata: { filepath: "/etc/hosts" } }),
    )
    await emit(
      hooks,
      askedEvent({ permission: "edit", metadata: { filepath: "/srv/secret/key" } }),
    )
    await new Promise((resolve) => setTimeout(resolve, 50))

    const fs = await import("fs/promises")
    const lines = (await fs.readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(lines).toHaveLength(5)
    expect(lines[0]).toMatchObject({ action: "approve", verdict: "safe" })
    expect(lines[1]).toMatchObject({ action: "approve", verdict: "safe" })
    expect(lines[2]).toMatchObject({
      action: "escalate",
      verdict: "dangerous",
      detail: "edit: .git path",
    })
    expect(lines[3]).toMatchObject({
      action: "escalate",
      verdict: "dangerous",
      detail: "edit: outside workspace",
    })
    expect(lines[4]).toMatchObject({
      action: "escalate",
      verdict: "dangerous",
      detail: "edit: sensitive path",
    })
    await fs.rm(logPath)
  })
})

describe("cross-gate consistency matrix (ADR-0005)", () => {
  const analyzerCtx = {
    workspace: WORKSPACE,
    cwd: WORKSPACE,
    homedir: "/home/dev",
    baseline: { status: () => "clean" as const },
    extraSensitiveRoots: ["/srv/secret"],
    scratchRoots: ["/tmp", "/private/tmp"],
  }
  const rows: Array<{
    path: string
    read: "allow" | "ask"
    mutate: "allow" | "ask"
    editReplies: boolean
    readOriginReplies: boolean
  }> = [
    { path: `${WORKSPACE}/src/app.ts`, read: "allow", mutate: "allow", editReplies: true, readOriginReplies: true },
    { path: `${WORKSPACE}/.git/config`, read: "allow", mutate: "ask", editReplies: false, readOriginReplies: true },
    { path: "/tmp/matrix-probe.ts", read: "allow", mutate: "allow", editReplies: true, readOriginReplies: true },
    { path: "/tmp/co/.git/config", read: "allow", mutate: "allow", editReplies: true, readOriginReplies: true },
    { path: "/tmp", read: "allow", mutate: "ask", editReplies: false, readOriginReplies: true },
    { path: "/srv/secret/key", read: "ask", mutate: "ask", editReplies: false, readOriginReplies: false },
    { path: "/etc/hosts", read: "allow", mutate: "ask", editReplies: false, readOriginReplies: true },
    { path: "/srv/ordinary.txt", read: "allow", mutate: "ask", editReplies: false, readOriginReplies: true },
  ]

  it("the edit gate and read-origin asks agree with the Bash verdicts per path class", async () => {
    const hooks = await makePlugin({ sensitivePaths: ["/srv/secret"] })
    for (const { path, read, mutate, editReplies, readOriginReplies } of rows) {
      expect(
        analyzeWorkspacePolicy(`cat ${path}`, analyzerCtx).action,
        `bash read ${path}`,
      ).toBe(read)
      expect(
        analyzeWorkspacePolicy(`strings /bin/ls > ${path}`, analyzerCtx).action,
        `bash mutate ${path}`,
      ).toBe(mutate)
      fetchMock.mockClear()
      await emit(hooks, askedEvent({ permission: "edit", metadata: { filepath: path } }))
      expect(fetchMock.mock.calls.length > 0, `edit gate ${path}`).toBe(editReplies)
      fetchMock.mockClear()
      await emit(
        hooks,
        askedEvent({ permission: "external_directory", metadata: { filepath: path } }),
      )
      expect(fetchMock.mock.calls.length > 0, `read-origin ask ${path}`).toBe(readOriginReplies)
      fetchMock.mockClear()
    }
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

describe("alert hooks", () => {
  it("escalations alert and replies clear the mark", async () => {
    const hooks = await makePlugin({ alert: { sound: true, mark: true } })
    await emit(hooks, askedEvent({ metadata: { command: "rm -rf /" } }))
    expect(vi.mocked(fireAlert)).toHaveBeenCalledTimes(1)
    await emit(hooks, askedEvent()) // git status is auto-approved
    expect(vi.mocked(fireAlert)).toHaveBeenCalledTimes(1)
    await emit(hooks, { type: "permission.replied", properties: {} })
    expect(vi.mocked(clearAlert)).toHaveBeenCalledTimes(1)
  })

  it("never alerts without the option", async () => {
    const hooks = await makePlugin()
    await emit(hooks, askedEvent({ metadata: { command: "rm -rf /" } }))
    await emit(hooks, { type: "permission.replied", properties: {} })
    expect(vi.mocked(fireAlert)).not.toHaveBeenCalled()
    expect(vi.mocked(clearAlert)).not.toHaveBeenCalled()
  })
})

describe("scratch roots (ADR-0004)", () => {
  it("default host list approves scratch mutations and keeps the root red line", async () => {
    const hooks = await makePlugin()
    await emit(hooks, askedEvent({ metadata: { command: "echo x > /tmp/out" } }))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await emit(hooks, askedEvent({ metadata: { command: "rm -rf /tmp/" } }))
    expect(fetchMock).toHaveBeenCalledTimes(1) // no second reply
  })

  it("scratchPaths: false disables the feature entirely", async () => {
    const hooks = await makePlugin({ scratchPaths: false })
    await emit(hooks, askedEvent({ metadata: { command: "echo x > /tmp/out" } }))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("a scratchPaths array replaces the default list", async () => {
    const hooks = await makePlugin({ scratchPaths: ["/srv/scratch"] })
    await emit(hooks, askedEvent({ metadata: { command: "echo x > /tmp/out" } }))
    expect(fetchMock).not.toHaveBeenCalled()
    await emit(hooks, askedEvent({ metadata: { command: "echo x > /srv/scratch/out" } }))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("a TMPDIR covering the workspace is rejected as a scratch root", async () => {
    vi.stubEnv("TMPDIR", "/Users/dev")
    const hooks = await makePlugin()
    await emit(hooks, askedEvent({ metadata: { command: "echo x > /Users/dev/tmp-out" } }))
    expect(fetchMock).not.toHaveBeenCalled()
    // /tmp remains scratch even when the TMPDIR candidate was rejected
    await emit(hooks, askedEvent({ metadata: { command: "echo x > /tmp/out" } }))
    expect(fetchMock).toHaveBeenCalledTimes(1)
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
    await emit(hooks, askedEvent({ metadata: { command: "rm -rf /etc/x" } }))
    await new Promise((resolve) => setTimeout(resolve, 50))

    const lines = (await fs.readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
    expect(lines).toHaveLength(2)
    for (const line of lines)
      expect(line.build).toBe(BUILD_ID)
    expect(lines).toContainEqual(
      expect.objectContaining({ gate: "bash", command: "git status", verdict: "safe", action: "approve" }),
    )
    expect(lines).toContainEqual(
      expect.objectContaining({ gate: "bash", command: "rm -rf /etc/x", verdict: "unanalyzable", action: "escalate" }),
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

describe("system prompt guidance", () => {
  async function transform(
    hooks: Awaited<ReturnType<Plugin>>,
    sessionID?: string,
  ) {
    const output = { system: [] as string[] }
    await hooks["experimental.chat.system.transform"]!(
      { sessionID, model: {} as never },
      output as never,
    )
    return output.system
  }

  it("appends the default guidance for session-bound requests", async () => {
    const hooks = await makePlugin()
    const system = await transform(hooks, "ses_456")
    expect(system).toHaveLength(1)
    expect(system[0]).toContain("opencode-bash-sentinel")
    expect(system[0]).toContain("temporary script")
  })

  it("skips session-less requests (hidden agents)", async () => {
    const hooks = await makePlugin()
    expect(await transform(hooks, undefined)).toHaveLength(0)
  })

  it("does not register the hook when disabled", async () => {
    const hooks = await makePlugin({ guidance: false })
    expect(hooks["experimental.chat.system.transform"]).toBeUndefined()
  })

  it("uses a custom text when provided", async () => {
    const hooks = await makePlugin({ guidance: "prefer plain commands" })
    expect(await transform(hooks, "ses_456")).toEqual(["prefer plain commands"])
  })

  it("empty string falls back to the default text, not off", async () => {
    const hooks = await makePlugin({ guidance: "" })
    const system = await transform(hooks, "ses_456")
    expect(system).toHaveLength(1)
    expect(system[0]).toContain("opencode-bash-sentinel")
  })

  it("the event hook still works alongside guidance", async () => {
    const hooks = await makePlugin()
    await emit(hooks, askedEvent({ metadata: { command: "cat /etc/hosts" } }))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
