import { describe, expect, it } from "vitest"
import { analyzeCommandPolicy } from "../src/policy-engine"
import { defaultWorkspaceContext } from "../src/workspace-policy"

const ctx = defaultWorkspaceContext("/Users/dev/project")
const decide = (command: string, gate: "bash" | "external_directory" = "bash") =>
  analyzeCommandPolicy(command, ctx, { gate })

describe("positive command policy", () => {
  it("allows only positively trusted command lines", () => {
    expect(decide("git status").action).toBe("allow")
    expect(decide("ls -la /tmp").action).toBe("allow")
    expect(decide("rm -rf build").action).toBe("allow")
  })

  it("asks for unknown names and untrusted executable paths", () => {
    expect(decide("totally-unknown-command --flag")).toMatchObject({
      action: "ask",
      reason: "command is not positively trusted",
    })
    expect(decide("/tmp/ls -la")).toMatchObject({
      action: "ask",
      reason: "command is not positively trusted",
    })
  })

  it("retains explicit workspace-script and developer-tool exceptions", () => {
    expect(decide("./scripts/check").action).toBe("allow")
    expect(decide("python script.py").action).toBe("allow")
    expect(decide("npm test").action).toBe("allow")
  })

  it("asks when a recognized command uses an unmodeled escape channel", () => {
    expect(decide("git push").action).toBe("ask")
    expect(decide("FOO=bar echo ok").action).toBe("ask")
    expect(decide("find . | xargs custom-tool").action).toBe("ask")
    expect(decide("find . -fprint /tmp/out").action).toBe("ask")
    expect(decide("rsync src/ dst/ --log-file=/tmp/log").action).toBe("ask")
  })

  it("requires both external-path coverage and Bash trust", () => {
    expect(decide("cat /etc/hosts", "external_directory").action).toBe("allow")
    expect(decide("custom-tool /etc/hosts", "external_directory").action).toBe("ask")
  })
})
