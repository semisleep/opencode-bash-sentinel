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
    expect(decide("printf x | xargs file --compile -m /tmp/magic").action).toBe("ask")
    expect(decide("printf -v PATH /tmp; ls").action).toBe("ask")
  })

  it("asks when interpreter options previously hid external scripts", () => {
    for (const command of [
      "python -W ignore /tmp/evil.py",
      "python -X dev /tmp/evil.py",
      "bash -O extglob /tmp/evil.sh",
      "ruby -I lib /tmp/evil.rb",
      "perl -I lib /tmp/evil.pl",
      "php -d display_errors=1 /tmp/evil.php",
      "node --require local-helper /tmp/evil.js",
      "python",
      "bash -O extglob",
    ]) {
      expect(decide(command).action).toBe("ask")
    }
  })

  it("asks for multi-target and workspace-root mutations", () => {
    expect(decide("install -d /tmp/external local-dir").action).toBe("ask")
    expect(decide("chmod 000 .").action).toBe("ask")
    expect(decide("touch .").action).toBe("ask")
  })

  it("asks for external search paths and opaque preload modules", () => {
    expect(decide("ruby -I /tmp script.rb").action).toBe("ask")
    expect(decide("perl -I lib:/tmp script.pl").action).toBe("ask")
    expect(decide("node --require local-helper server.js").action).toBe("ask")
    expect(decide("node --import=data:text/javascript,evil server.js").action).toBe("ask")
    expect(decide("node --require ./local-helper server.js").action).toBe("allow")
  })

  it("requires both external-path coverage and Bash trust", () => {
    expect(decide("cat /etc/hosts", "external_directory").action).toBe("allow")
    expect(decide("custom-tool /etc/hosts", "external_directory").action).toBe("ask")
  })
})
