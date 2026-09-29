import { afterEach, describe, expect, it, vi } from "vitest"
import { BashSentinelPlugin } from "../src/plugin"
import { analyzeWorkspacePolicy } from "../src/workspace-policy"
import { BUILD_ID } from "../src/version"
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

const WORKSPACE = "/Users/dev/project"
const BASH = "/opt/homebrew/bin/bash"
const HOME = os.homedir()

type Effect = "allow" | "deny" | "ask"
type Callback = (event: any) => unknown

type Request = {
  action: string
  resources: string[]
  metadata?: Record<string, unknown>
  effect?: Effect
}

type Host = Awaited<ReturnType<typeof makeHost>>

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

// A fake OpenCode 2.x Promise plugin context: hook registries per domain and
// an event stream the test can push into.
async function makeHost(
  options: Record<string, unknown> = {},
  location: { directory?: string; project?: string } = {},
) {
  const hooks = new Map<string, Callback[]>()
  const register = (domain: string) => async (name: string, callback: Callback) => {
    const key = `${domain}.${name}`
    hooks.set(key, [...(hooks.get(key) ?? []), callback])
    return { dispose: async () => {} }
  }
  const events: unknown[] = []
  let wake: (() => void) | undefined
  const subscribe = ({ signal }: { signal: AbortSignal }) => ({
    async *[Symbol.asyncIterator]() {
      while (!signal.aborted) {
        const next = events.shift()
        if (next !== undefined) {
          yield next
          continue
        }
        await new Promise<void>((resolve) => {
          wake = resolve
          signal.addEventListener("abort", () => resolve(), { once: true })
        })
      }
    },
  })
  const ctx = {
    options,
    location: {
      directory: location.directory ?? WORKSPACE,
      project: { id: "prj", directory: location.project ?? location.directory ?? WORKSPACE },
    },
    tool: { hook: register("tool") },
    shell: { hook: register("shell") },
    permission: { hook: register("permission") },
    session: { hook: register("session") },
    event: { subscribe },
  }
  const cleanup = await BashSentinelPlugin.setup(ctx as never)

  async function trigger(key: string, event: unknown) {
    for (const callback of hooks.get(key) ?? []) await callback(event)
    return event
  }

  let counter = 0
  async function call(
    tool: string,
    input: Record<string, unknown>,
    requests: Request[],
    options: {
      shell?: string | false
      sessionID?: string
      id?: string
      agent?: string
      finish?: boolean
    } = {},
  ): Promise<Effect[]> {
    const sessionID = options.sessionID ?? "ses_1"
    const id = options.id ?? `call_${++counter}`
    await trigger("tool.execute.before", { tool, sessionID, agent: "build", messageID: "msg_1", id, input })
    if (tool === "shell" && options.shell !== false) {
      await trigger("shell.create.before", {
        command: input.command,
        cwd: WORKSPACE,
        timeout: 0,
        shell: options.shell ?? BASH,
        env: {},
      })
    }
    const effects: Effect[] = []
    for (const request of requests) {
      const event = await evaluate({ ...request, sessionID, id, agent: options.agent })
      effects.push(event.effect)
    }
    if (options.finish !== false) {
      await trigger("tool.execute.after", {
        tool,
        sessionID,
        agent: "build",
        messageID: "msg_1",
        id,
        input,
        status: "completed",
        result: { content: [] },
      })
    }
    return effects
  }

  async function evaluate(request: Request & { sessionID?: string; id?: string; agent?: string; source?: unknown }) {
    return (await trigger("permission.evaluate", {
      sessionID: request.sessionID ?? "ses_1",
      agent: request.agent ?? "build",
      action: request.action,
      resources: request.resources,
      metadata: request.metadata,
      source: "source" in request ? request.source : { type: "tool", messageID: "msg_1", id: request.id ?? "none" },
      effect: request.effect ?? "ask",
    })) as { effect: Effect }
  }

  /** A shell call raising the engine's `shell` ask, resources = the command. */
  async function shell(command: string, options: Parameters<typeof call>[3] & { workdir?: string } = {}) {
    const input = options.workdir === undefined ? { command } : { command, workdir: options.workdir }
    const [effect] = await call("shell", input, [{ action: "shell", resources: [command] }], options)
    return effect
  }

  /** A shell call raising only its `external_directory` ask. */
  async function shellExternal(command: string, resources: string[] = ["/etc/*"]) {
    const [effect] = await call("shell", { command }, [{ action: "external_directory", resources }])
    return effect
  }

  async function external(tool: string, input: Record<string, unknown>, resources: string[], metadata?: Record<string, unknown>) {
    const [effect] = await call(tool, input, [{ action: "external_directory", resources, metadata }])
    return effect
  }

  async function edit(resources: string[]) {
    const [effect] = await call("edit", { path: resources[0] }, [{ action: "edit", resources }])
    return effect
  }

  async function emit(event: unknown) {
    events.push(event)
    wake?.()
    await new Promise((resolve) => setTimeout(resolve, 5))
  }

  return { hooks, trigger, call, evaluate, shell, shellExternal, external, edit, emit, cleanup }
}

async function readAudit(logPath: string) {
  await new Promise((resolve) => setTimeout(resolve, 50))
  const fs = await import("fs/promises")
  const lines = (await fs.readFile(logPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
  await fs.rm(logPath)
  return lines
}

function tempLog(name: string) {
  return path.join(os.tmpdir(), `sentinel-${name}-${process.pid}-${Date.now()}.jsonl`)
}

describe("host contract", () => {
  it("exports a v2 plugin definition with an id and setup", () => {
    expect(BashSentinelPlugin.id).toBe("opencode-bash-sentinel")
    expect(typeof BashSentinelPlugin.setup).toBe("function")
  })

  it("registers the correlation, dialect and evaluate hooks", async () => {
    const host = await makeHost()
    for (const key of ["tool.execute.before", "tool.execute.after", "shell.create.before", "permission.evaluate"])
      expect(host.hooks.get(key), key).toHaveLength(1)
  })
})

describe("shell gate", () => {
  it("recognized workspace commands are allowed in-band", async () => {
    const host = await makeHost()
    expect(await host.shell("git status")).toBe("allow")
    expect(await host.shell("rm -rf build")).toBe("allow")
  })

  it("writes outside the workspace keep asking", async () => {
    const host = await makeHost()
    for (const command of ["echo x > /etc/out", "rm ~/.zshrc", "sed -i s/a/b/ /etc/hosts", "python -c 'x'"])
      expect(await host.shell(command), command).toBe("ask")
  })

  it("workspace-root and relative-escape writes keep asking", async () => {
    const host = await makeHost()
    expect(await host.shell("rm -rf .")).toBe("ask")
    expect(await host.shell("echo x > ../outside")).toBe("ask")
  })

  it("dangerous, unknown and untrusted forms fail closed", async () => {
    const host = await makeHost()
    for (const command of [
      "sudo shutdown",
      "dd if=x of=/dev/sda",
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
    ])
      expect(await host.shell(command), command).toBe("ask")
  })

  it("does not approve scripts or workflows when their Git baseline cannot be verified", async () => {
    const host = await makeHost()
    for (const command of ["npm test", "make test", "python script.py", "bash scripts/build.sh", "./scripts/check"])
      expect(await host.shell(command), command).toBe("ask")
  })

  it("resolves relative commands from the location directory, not the project root", async () => {
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

      const host = await makeHost({}, { directory, project: worktree })
      expect(await host.shell("./check.sh")).toBe("ask")
    } finally {
      rmSync(worktree, { recursive: true, force: true })
    }
  })

  it("uses the shell tool's workdir as the effective cwd (ADR-0006 §5)", async () => {
    const host = await makeHost()
    // From the workspace root, ../out.txt escapes; from sub/ it stays inside.
    expect(await host.shell("echo x > ../out.txt")).toBe("ask")
    expect(await host.shell("echo x > ../out.txt", { workdir: "sub" })).toBe("allow")
    expect(await host.shell("echo x > ../out.txt", { workdir: `${WORKSPACE}/sub` })).toBe("allow")
    // An external workdir makes a relative mutation external.
    expect(await host.shell("rm tmp.txt", { workdir: "/etc" })).toBe("ask")
    expect(await host.shell("rm tmp.txt", { workdir: "~" })).toBe("ask")
  })

  it("the removed upstream option can no longer disable fail-closed policy", async () => {
    const host = await makeHost({ upstream: true })
    expect(await host.shell("echo x > /etc/out")).toBe("ask")
  })
})

describe("correlation and binding (ADR-0006 §3-§4)", () => {
  it("an uncorrelated request keeps asking", async () => {
    const host = await makeHost()
    const event = await host.evaluate({ action: "shell", resources: ["git status"], id: "never-started" })
    expect(event.effect).toBe("ask")
  })

  it("a non-tool source or a missing source keeps asking", async () => {
    const host = await makeHost()
    for (const source of [undefined, { type: "other", messageID: "m", id: "x" }]) {
      await host.trigger("tool.execute.before", {
        tool: "shell",
        sessionID: "ses_1",
        agent: "build",
        messageID: "msg_1",
        id: "x",
        input: { command: "git status" },
      })
      const event = await host.evaluate({ action: "shell", resources: ["git status"], source })
      expect(event.effect).toBe("ask")
    }
  })

  it("a call ID from another session keeps asking", async () => {
    const host = await makeHost()
    await host.call("shell", { command: "git status" }, [], { sessionID: "ses_a", id: "shared", finish: false })
    const event = await host.evaluate({ action: "shell", resources: ["git status"], sessionID: "ses_b", id: "shared" })
    expect(event.effect).toBe("ask")
  })

  it("resources that are not slices of the captured command keep asking", async () => {
    const host = await makeHost()
    const [effect] = await host.call("shell", { command: "git status" }, [
      { action: "shell", resources: ["rm -rf /"] },
    ])
    expect(effect).toBe("ask")
    const [empty] = await host.call("shell", { command: "git status" }, [{ action: "shell", resources: [] }])
    expect(empty).toBe("ask")
  })

  it("compound commands bind through their per-command slices", async () => {
    const host = await makeHost()
    const [effect] = await host.call("shell", { command: "git status && git diff" }, [
      { action: "shell", resources: ["git status", "git diff"] },
    ])
    expect(effect).toBe("allow")
  })

  it("a duplicate call ID poisons the record", async () => {
    const host = await makeHost()
    await host.call("shell", { command: "git status" }, [], { id: "dup", finish: false })
    await host.trigger("tool.execute.before", {
      tool: "shell",
      sessionID: "ses_1",
      agent: "build",
      messageID: "msg_1",
      id: "dup",
      input: { command: "git status" },
    })
    const event = await host.evaluate({ action: "shell", resources: ["git status"], id: "dup" })
    expect(event.effect).toBe("ask")
  })

  it("a shell request correlated to another tool keeps asking", async () => {
    const host = await makeHost()
    const [effect] = await host.call("read", { path: "src/app.ts" }, [{ action: "shell", resources: ["git status"] }])
    expect(effect).toBe("ask")
  })

  it("records are removed at execute.after", async () => {
    const host = await makeHost()
    await host.call("shell", { command: "git status" }, [], { id: "done" })
    const event = await host.evaluate({ action: "shell", resources: ["git status"], id: "done" })
    expect(event.effect).toBe("ask")
  })

  it("map overflow evicts the oldest record, which then asks", async () => {
    const host = await makeHost()
    await host.call("shell", { command: "git status" }, [], { id: "oldest", finish: false })
    for (let index = 0; index < 256; index++)
      await host.call("read", { path: "x" }, [], { id: `filler_${index}`, finish: false })
    const event = await host.evaluate({ action: "shell", resources: ["git status"], id: "oldest" })
    expect(event.effect).toBe("ask")
  })
})

describe("dialect gate (ADR-0006 §9)", () => {
  it("zsh execution keeps asking, including the =cmd expansion", async () => {
    const host = await makeHost()
    expect(await host.shell("git status", { shell: "/bin/zsh" })).toBe("ask")
    expect(await host.shell("rm -f =node", { shell: "/bin/zsh" })).toBe("ask")
  })

  it("the same command under Bash gets the policy verdict", async () => {
    const host = await makeHost()
    expect(await host.shell("git status", { shell: "/bin/bash" })).toBe("allow")
  })

  it("an unobserved invocation keeps asking", async () => {
    const host = await makeHost()
    expect(await host.shell("git status", { shell: false })).toBe("ask")
  })

  it("the same command text observed under Bash and zsh keeps asking", async () => {
    const host = await makeHost()
    await host.call("shell", { command: "git status" }, [], { shell: "/bin/zsh", finish: false })
    expect(await host.shell("git status")).toBe("ask")
  })

  it("sh and other interpreters keep asking", async () => {
    const host = await makeHost()
    for (const shell of ["/bin/sh", "/bin/dash", "/usr/bin/fish", "pwsh"])
      expect(await host.shell("git status", { shell }), shell).toBe("ask")
  })

  it("shell-origin directory asks pass the dialect gate too", async () => {
    const host = await makeHost()
    const [effect] = await host.call(
      "shell",
      { command: "cat /etc/hosts" },
      [{ action: "external_directory", resources: ["/etc/*"] }],
      { shell: "/bin/zsh" },
    )
    expect(effect).toBe("ask")
  })
})

describe("in-band effect rules (ADR-0006 §2)", () => {
  it("an arriving deny stays deny", async () => {
    const host = await makeHost()
    const [effect] = await host.call("shell", { command: "git status" }, [
      { action: "shell", resources: ["git status"], effect: "deny" },
    ])
    expect(effect).toBe("deny")
  })

  it("an arriving allow stays allow, even for a command Sentinel would ask on", async () => {
    const host = await makeHost()
    const [effect] = await host.call("shell", { command: "cat ~/.ssh/id_rsa" }, [
      { action: "shell", resources: ["cat ~/.ssh/id_rsa"], effect: "allow" },
    ])
    expect(effect).toBe("allow")
  })

  it("an internal exception leaves the effect untouched and never rejects", async () => {
    const host = await makeHost()
    await host.call("shell", { command: "git status" }, [], { id: "boom", finish: false })
    const event = {
      sessionID: "ses_1",
      action: "shell",
      get resources(): string[] {
        throw new Error("boom")
      },
      source: { type: "tool", messageID: "msg_1", id: "boom" },
      effect: "ask" as Effect,
    }
    await expect(host.trigger("permission.evaluate", event)).resolves.toBe(event)
    expect(event.effect).toBe("ask")
  })

  it("actions outside the consumed gates are untouched", async () => {
    const host = await makeHost()
    for (const action of ["webfetch", "read", "glob", "question", "subagent"]) {
      const event = await host.evaluate({ action, resources: ["*"] })
      expect(event.effect, action).toBe("ask")
    }
    expect(vi.mocked(fireAlert)).not.toHaveBeenCalled()
  })
})

describe("external_directory gate", () => {
  it("shell-origin read-only external commands are allowed", async () => {
    const host = await makeHost()
    expect(await host.shellExternal("cat /etc/hosts")).toBe("allow")
    expect(await host.shellExternal("cd /tmp && ls", ["/tmp/*"])).toBe("allow")
    expect(await host.shellExternal("cat /etc/hosts > out.txt")).toBe("allow")
  })

  it("shell and external_directory remain independent for dangerous commands", async () => {
    const host = await makeHost()
    expect(await host.shellExternal("rm /etc/x")).toBe("ask")
    expect(await host.shell("rm /etc/x")).toBe("ask")
  })

  it("does not approve external paths for unmodeled commands", async () => {
    const host = await makeHost()
    for (const command of [
      "curl -o /tmp/out https://example.invalid/x",
      "tar -xf archive.tar -C /tmp",
      "cpio -id --directory=/tmp < archive.cpio",
      "git clone https://example.invalid/repo /tmp/repo",
      `awk -v out=/tmp/x 'BEGIN { print 1 > out }'`,
      "cp /etc/hosts local-copy",
    ])
      expect(await host.shellExternal(command, ["/tmp/*"]), command).toBe("ask")
  })

  it("read-origin asks follow the outside-workspace read rule (ADR-0003)", async () => {
    const host = await makeHost()
    expect(await host.external("read", { path: "/etc/hosts" }, ["/etc/*"])).toBe("allow")
    expect(await host.external("read", { path: "/etc" }, ["/etc/*"])).toBe("allow")
    expect(await host.external("glob", { pattern: "**", path: "/tmp" }, ["/tmp/*"])).toBe("allow")
    expect(await host.external("grep", { pattern: "x", path: "/etc/hosts" }, ["/etc/*"])).toBe("allow")
    expect(await host.external("read", { path: "~/.config/x" }, [`${HOME}/.config/*`])).toBe("allow")
  })

  it("sensitive, glob-shaped and unbound read asks keep asking", async () => {
    const host = await makeHost()
    expect(await host.external("read", { path: "~/.ssh/id_rsa" }, [`${HOME}/.ssh/*`])).toBe("ask")
    expect(await host.external("glob", { pattern: "*", path: "~/.ssh" }, [`${HOME}/.ssh/*`])).toBe("ask")
    expect(await host.external("read", { path: "/etc/*" }, ["/etc/*"])).toBe("ask")
    expect(await host.external("read", { path: "/etc/hosts" }, ["/var/*"])).toBe("ask")
    expect(await host.external("read", { path: "/etc/hosts" }, ["/etc/*", "/var/*"])).toBe("ask")
    expect(await host.external("read", { path: "~root/x" }, ["/var/root/*"])).toBe("ask")
  })

  it("glob treats literal undefined/null paths as the location directory", async () => {
    const host = await makeHost()
    expect(await host.external("glob", { pattern: "*", path: "undefined" }, [`${WORKSPACE}/*`])).toBe("allow")
  })

  it("write-origin asks follow the shared mutation rule (ADR-0006 §6)", async () => {
    const host = await makeHost()
    expect(await host.external("write", { path: "/tmp/s/f.txt" }, ["/tmp/s/*"])).toBe("allow")
    expect(await host.external("edit", { path: "/tmp/co/.git/config" }, ["/tmp/co/.git/*"])).toBe("allow")
    expect(await host.external("write", { path: "/tmp" }, ["/*"])).toBe("ask")
    expect(await host.external("write", { path: "~/.ssh/config" }, [`${HOME}/.ssh/*`])).toBe("ask")
    expect(await host.external("write", { path: "/etc/hosts" }, ["/etc/*"])).toBe("ask")
    expect(await host.external("write", { path: "/tmp/s/f.txt" }, ["/tmp/*"])).toBe("ask")
  })

  it("a scratch write passes both of its asks", async () => {
    const host = await makeHost()
    const effects = await host.call("write", { path: "/tmp/s/f.txt", content: "x" }, [
      { action: "external_directory", resources: ["/tmp/s/*"] },
      { action: "edit", resources: ["/tmp/s/f.txt"] },
    ])
    expect(effects).toEqual(["allow", "allow"])
  })

  it("patch asks bind through the engine's filepath and parentDir metadata", async () => {
    const host = await makeHost()
    const effects = await host.call("patch", { patchText: "…" }, [
      { action: "external_directory", resources: ["/tmp/s/*"], metadata: { filepath: "/tmp/s/a.txt", parentDir: "/tmp/s" } },
      { action: "external_directory", resources: ["/tmp/t/*"], metadata: { filepath: "/tmp/t/b.txt", parentDir: "/tmp/t" } },
      { action: "edit", resources: ["/tmp/s/a.txt", "/tmp/t/b.txt"] },
    ])
    expect(effects).toEqual(["allow", "allow", "allow"])
    const [mismatch] = await host.call("patch", { patchText: "…" }, [
      { action: "external_directory", resources: ["/tmp/s/*"], metadata: { filepath: "/tmp/s/a.txt", parentDir: "/tmp" } },
    ])
    expect(mismatch).toBe("ask")
    const [missing] = await host.call("patch", { patchText: "…" }, [
      { action: "external_directory", resources: ["/tmp/s/*"] },
    ])
    expect(missing).toBe("ask")
    const [sensitive] = await host.call("patch", { patchText: "…" }, [
      {
        action: "external_directory",
        resources: [`${HOME}/.ssh/*`],
        metadata: { filepath: `${HOME}/.ssh/config`, parentDir: `${HOME}/.ssh` },
      },
    ])
    expect(sensitive).toBe("ask")
  })

  it("asks from tools outside the catalogue keep asking and are audited", async () => {
    const logPath = tempLog("uncorrelated")
    const host = await makeHost({ audit: true, logPath })
    const [effect] = await host.call("skill", { name: "x" }, [{ action: "external_directory", resources: ["/etc/*"] }])
    expect(effect).toBe("ask")
    const lines = await readAudit(logPath)
    expect(lines).toEqual([
      expect.objectContaining({ gate: "external_directory", action: "escalate", reason: "uncorrelated", command: "/etc/*" }),
    ])
  })
})

describe("edit gate", () => {
  it("in-workspace edits are allowed, relative or absolute", async () => {
    const host = await makeHost()
    expect(await host.edit(["src/app.ts"])).toBe("allow")
    expect(await host.edit([`${WORKSPACE}/src/app.ts`])).toBe("allow")
    expect(await host.edit(["src/a.ts", "src/b.ts"])).toBe("allow")
  })

  it(".git, outside and escaping paths keep asking", async () => {
    const host = await makeHost()
    expect(await host.edit([".git/config"])).toBe("ask")
    expect(await host.edit(["/etc/hosts"])).toBe("ask")
    expect(await host.edit(["/Users/dev/.zshrc"])).toBe("ask")
    expect(await host.edit(["../../outside.txt"])).toBe("ask")
  })

  it("every resource of a multi-file edit must pass", async () => {
    const host = await makeHost()
    expect(await host.edit(["src/a.ts", "/etc/hosts"])).toBe("ask")
  })

  it("does not treat glob-shaped or empty resources as concrete paths", async () => {
    const host = await makeHost()
    expect(await host.edit(["**"])).toBe("ask")
    expect(await host.edit(["{src,.git}/**"])).toBe("ask")
    expect(await host.edit([""])).toBe("ask")
    expect(await host.edit([])).toBe("ask")
  })

  it("scratch descendants allow and the root itself asks (ADR-0005)", async () => {
    const host = await makeHost()
    expect(await host.edit(["/tmp/sentinel-probe.ts"])).toBe("allow")
    expect(await host.edit(["/tmp/checkout/.git/config"])).toBe("allow")
    expect(await host.edit(["/tmp"])).toBe("ask")
  })

  it("sensitive external edits ask even under a scratch root", async () => {
    const host = await makeHost({ sensitivePaths: ["/srv/secret"], scratchPaths: ["/srv"] })
    expect(await host.edit(["/srv/secret/key"])).toBe("ask")
    expect(await host.edit(["/srv/other"])).toBe("allow")
  })

  it("scratchPaths: false restores the pre-ADR-0005 edit gate", async () => {
    const host = await makeHost({ scratchPaths: false })
    expect(await host.edit(["/tmp/sentinel-probe.ts"])).toBe("ask")
  })

  it("audit lines pin the edit-gate reason strings", async () => {
    const logPath = tempLog("edit")
    const host = await makeHost({ audit: true, logPath, sensitivePaths: ["/srv/secret"] })
    for (const target of ["/tmp/sentinel-probe.ts", "/tmp/co/.git/config", ".git/config", "/etc/hosts", "/srv/secret/key"])
      await host.edit([target])
    const lines = await readAudit(logPath)
    expect(lines).toHaveLength(5)
    expect(lines[0]).toMatchObject({ gate: "edit", action: "approve", verdict: "safe" })
    expect(lines[1]).toMatchObject({ gate: "edit", action: "approve", verdict: "safe" })
    expect(lines[2]).toMatchObject({ action: "escalate", verdict: "dangerous", detail: "edit: .git path" })
    expect(lines[3]).toMatchObject({ action: "escalate", verdict: "dangerous", detail: "edit: outside workspace" })
    expect(lines[4]).toMatchObject({ action: "escalate", verdict: "dangerous", detail: "edit: sensitive path" })
  })
})

describe("cross-gate consistency matrix (ADR-0005, ADR-0006)", () => {
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
    read: Effect
    mutate: Effect
    edit: Effect
    readOrigin: Effect
    writeOrigin?: Effect
  }> = [
    { path: `${WORKSPACE}/src/app.ts`, read: "allow", mutate: "allow", edit: "allow", readOrigin: "allow" },
    { path: `${WORKSPACE}/.git/config`, read: "allow", mutate: "ask", edit: "ask", readOrigin: "allow" },
    { path: "/tmp/matrix-probe.ts", read: "allow", mutate: "allow", edit: "allow", readOrigin: "allow", writeOrigin: "allow" },
    { path: "/tmp/co/.git/config", read: "allow", mutate: "allow", edit: "allow", readOrigin: "allow", writeOrigin: "allow" },
    { path: "/tmp", read: "allow", mutate: "ask", edit: "ask", readOrigin: "allow", writeOrigin: "ask" },
    { path: "/srv/secret/key", read: "ask", mutate: "ask", edit: "ask", readOrigin: "ask", writeOrigin: "ask" },
    { path: "/etc/hosts", read: "allow", mutate: "ask", edit: "ask", readOrigin: "allow", writeOrigin: "ask" },
    { path: "/srv/ordinary.txt", read: "allow", mutate: "ask", edit: "ask", readOrigin: "allow", writeOrigin: "ask" },
  ]

  it("every gate agrees with the Bash verdicts per path class", async () => {
    const host = await makeHost({ sensitivePaths: ["/srv/secret"], scratchPaths: ["/tmp", "/private/tmp"] })
    for (const row of rows) {
      expect(analyzeWorkspacePolicy(`cat ${row.path}`, analyzerCtx).action, `bash read ${row.path}`).toBe(row.read)
      expect(
        analyzeWorkspacePolicy(`strings /bin/ls > ${row.path}`, analyzerCtx).action,
        `bash mutate ${row.path}`,
      ).toBe(row.mutate)
      expect(await host.edit([row.path]), `edit gate ${row.path}`).toBe(row.edit)
      expect(
        await host.external("read", { path: row.path }, [path.join(path.dirname(row.path), "*")]),
        `read-origin ask ${row.path}`,
      ).toBe(row.readOrigin)
      if (row.writeOrigin !== undefined)
        expect(
          await host.external("write", { path: row.path }, [path.join(path.dirname(row.path), "*")]),
          `write-origin ask ${row.path}`,
        ).toBe(row.writeOrigin)
    }
  })
})

describe("scratch roots (ADR-0004)", () => {
  it("default host list allows scratch mutations and keeps the root red line", async () => {
    const host = await makeHost()
    expect(await host.shell("echo x > /tmp/out")).toBe("allow")
    expect(await host.shell("rm -rf /tmp/")).toBe("ask")
  })

  it("scratchPaths: false disables the feature entirely", async () => {
    const host = await makeHost({ scratchPaths: false })
    expect(await host.shell("echo x > /tmp/out")).toBe("ask")
  })

  it("a scratchPaths array replaces the default list", async () => {
    const host = await makeHost({ scratchPaths: ["/srv/scratch"] })
    expect(await host.shell("echo x > /tmp/out")).toBe("ask")
    expect(await host.shell("echo x > /srv/scratch/out")).toBe("allow")
  })

  it("a TMPDIR covering the workspace is rejected as a scratch root", async () => {
    vi.stubEnv("TMPDIR", "/Users/dev")
    const host = await makeHost()
    expect(await host.shell("echo x > /Users/dev/tmp-out")).toBe("ask")
    expect(await host.shell("echo x > /tmp/out")).toBe("allow")
  })
})

describe("baseline detection (ADR-0006 §11)", () => {
  it("arriving allows are audited as engine-allowed", async () => {
    const logPath = tempLog("engine-allowed")
    const host = await makeHost({ audit: true, logPath })
    vi.spyOn(console, "warn").mockImplementation(() => {})
    await host.call("shell", { command: "git status" }, [{ action: "shell", resources: ["git status"], effect: "allow" }])
    await host.call("edit", { path: "src/a.ts" }, [{ action: "edit", resources: ["src/a.ts"], effect: "allow" }])
    const lines = await readAudit(logPath)
    expect(lines).toEqual([
      expect.objectContaining({ gate: "shell", action: "engine-allowed", command: "git status", reason: "agent: build" }),
      expect.objectContaining({ gate: "edit", action: "engine-allowed", command: "src/a.ts" }),
    ])
  })

  it("warns once per agent and action", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const host = await makeHost()
    for (let index = 0; index < 3; index++)
      await host.call("shell", { command: "ls" }, [{ action: "shell", resources: ["ls"], effect: "allow" }])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain("agents.<id>.permissions")
    await host.call("edit", { path: "a" }, [{ action: "edit", resources: ["a"], effect: "allow" }])
    expect(warn).toHaveBeenCalledTimes(2)
    await host.call("shell", { command: "ls" }, [{ action: "shell", resources: ["ls"], effect: "allow" }], {
      agent: "general",
    })
    expect(warn).toHaveBeenCalledTimes(3)
  })

  it("an arriving allow on external_directory is audited but does not warn", async () => {
    const logPath = tempLog("engine-allowed-external")
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const host = await makeHost({ audit: true, logPath })
    await host.call("read", { path: "/tmp/x" }, [{ action: "external_directory", resources: ["/tmp/*"], effect: "allow" }])
    // Uncorrelated arriving allows are not Sentinel's concern at all.
    await host.evaluate({ action: "external_directory", resources: ["/tmp/*"], effect: "allow", id: "none" })
    expect(warn).not.toHaveBeenCalled()
    const lines = await readAudit(logPath)
    expect(lines).toEqual([
      expect.objectContaining({ gate: "external_directory", action: "engine-allowed", command: "/tmp/x" }),
    ])
  })
})

describe("alerts", () => {
  it("escalations alert, approvals do not, and replies clear the mark", async () => {
    const host = await makeHost({ alert: { sound: true, mark: true } })
    expect(await host.shell("rm -rf /")).toBe("ask")
    expect(vi.mocked(fireAlert)).toHaveBeenCalledTimes(1)
    expect(await host.shell("git status")).toBe("allow")
    expect(vi.mocked(fireAlert)).toHaveBeenCalledTimes(1)
    await host.emit({ type: "session.updated", data: {} })
    expect(vi.mocked(clearAlert)).not.toHaveBeenCalled()
    await host.emit({ type: "permission.replied", data: { sessionID: "ses_1", requestID: "per_1", reply: "once" } })
    expect(vi.mocked(clearAlert)).toHaveBeenCalledTimes(1)
    await host.cleanup?.()
  })

  it("uncorrelated external_directory asks alert too; other actions never do", async () => {
    const host = await makeHost({ alert: true })
    const [effect] = await host.call("skill", { name: "x" }, [{ action: "external_directory", resources: ["/etc/*"] }])
    expect(effect).toBe("ask")
    expect(vi.mocked(fireAlert)).toHaveBeenCalledTimes(1)
    await host.evaluate({ action: "webfetch", resources: ["https://example.invalid"] })
    expect(vi.mocked(fireAlert)).toHaveBeenCalledTimes(1)
  })

  it("never alerts without the option", async () => {
    const host = await makeHost()
    expect(await host.shell("rm -rf /")).toBe("ask")
    await host.emit({ type: "permission.replied", data: {} })
    expect(vi.mocked(fireAlert)).not.toHaveBeenCalled()
    expect(vi.mocked(clearAlert)).not.toHaveBeenCalled()
  })
})

describe("audit log", () => {
  it("appends one JSONL line per decision when enabled", async () => {
    const logPath = tempLog("audit")
    const host = await makeHost({ audit: true, logPath })
    await host.shell("git status")
    await host.shell("rm -rf /etc/x")
    await host.shell("git status", { shell: "/bin/zsh" })
    const lines = await readAudit(logPath)
    expect(lines).toHaveLength(3)
    for (const line of lines) expect(line.build).toBe(BUILD_ID)
    expect(lines[0]).toMatchObject({ gate: "shell", command: "git status", verdict: "safe", action: "approve" })
    expect(lines[1]).toMatchObject({ gate: "shell", command: "rm -rf /etc/x", verdict: "unanalyzable", action: "escalate" })
    expect(lines[2]).toMatchObject({ gate: "shell", command: "git status", action: "escalate", reason: "dialect: zsh" })
  })

  it("does not write anything by default", async () => {
    const logPath = tempLog("default")
    const host = await makeHost({ logPath })
    await host.shell("git status")
    await new Promise((resolve) => setTimeout(resolve, 50))
    const fs = await import("fs/promises")
    await expect(fs.access(logPath)).rejects.toThrow()
  })
})

describe("system prompt guidance", () => {
  async function context(host: Host) {
    const event = { system: [] as Array<{ type: string; text: string }> }
    await host.trigger("session.context", event)
    return event.system
  }

  it("appends the default guidance to primary requests", async () => {
    const host = await makeHost()
    const system = await context(host)
    expect(system).toHaveLength(1)
    expect(system[0]!.type).toBe("text")
    expect(system[0]!.text).toContain("opencode-bash-sentinel")
    expect(system[0]!.text).toContain("temporary script")
  })

  it("does not register the hook when disabled", async () => {
    const host = await makeHost({ guidance: false })
    expect(host.hooks.get("session.context")).toBeUndefined()
  })

  it("uses a custom text when provided", async () => {
    const host = await makeHost({ guidance: "prefer plain commands" })
    expect(await context(host)).toEqual([{ type: "text", text: "prefer plain commands" }])
  })

  it("empty string falls back to the default text, not off", async () => {
    const host = await makeHost({ guidance: "" })
    const system = await context(host)
    expect(system).toHaveLength(1)
    expect(system[0]!.text).toContain("opencode-bash-sentinel")
  })
})
