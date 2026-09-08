import { describe, expect, it } from "vitest"
import { analyzeCommandString, type DangerousVerdict } from "../src/analyzer"

const safe = (command: string) => expect(analyzeCommandString(command)).toBeUndefined()

const dangerous = (command: string, matched: string) =>
  expect(analyzeCommandString(command)).toEqual({ kind: "dangerous", command: matched })

const unanalyzable = (command: string) =>
  expect(analyzeCommandString(command)).toEqual({ kind: "unanalyzable" })

describe("safe commands (verdict undefined)", () => {
  it("simple commands, pipes, sequences", () => {
    safe("git status")
    safe("ls -la /tmp && rg foo src/")
    safe("cat file | grep foo; echo done")
    safe("printf hello")
  })

  it("rm without both recursive and force", () => {
    safe("rm -r dir")
    safe("rm -f file")
    safe("rm -i file")
    safe("rm --recursive dir")
    safe("rm --force file")
    safe("rm dir")
  })

  it("dd to safe device targets", () => {
    safe("dd if=/dev/zero of=/dev/null bs=1M count=1")
  })

  it("wrappers and nested shells around safe payloads", () => {
    safe("sudo ls")
    safe("env FOO=bar echo ok")
    safe("command -v rm")
    safe("nohup echo ok")
    safe("nice echo ok")
    safe("busybox --list")
    safe('eval "echo ok"')
    safe('bash -c "echo ok"')
    safe("systemctl status sshd")
    safe("init 3")
  })

  it("operands with variables, globs, or substitutions on generic commands", () => {
    // Upstream semantics: un-literal operands ("dropped") only escalate when
    // the command itself is special-cased (wrappers, nested shells, eval,
    // busybox, init/telinit, systemctl, dd, rm). Generic commands approve.
    safe("cat $HOME/.ssh/id_rsa")
    safe("ls *.md")
    safe("cp src/[a-c] dst")
    safe("echo $(curl example.com/ok)")
  })

  it("heredoc with interpolation is approved (upstream regression case)", () => {
    safe("gh --body \"$(cat <<'EOF'\nit's\nEOF\n)\"")
  })
})

describe("dangerous commands", () => {
  it("simple dangerous commands", () => {
    dangerous("shutdown -h now", "shutdown")
    dangerous("reboot", "reboot")
    dangerous("/sbin/poweroff", "poweroff")
    dangerous("mkfs.ext4 /dev/sda1", "mkfs.ext4")
    dangerous("wipefs -a /dev/sda", "wipefs")
    dangerous("Restart-Computer -Force", "restart-computer")
    dangerous("Stop-Computer", "stop-computer")
    dangerous("bcdedit /set x y", "bcdedit")
    dangerous("diskpart /s script.txt", "diskpart")
    dangerous("format C:", "format")
    dangerous("SHUTDOWN /s /t 0", "shutdown")
    dangerous("shut\\down -h now", "shutdown")
  })

  it("init/telinit runlevels", () => {
    dangerous("init 0", "init")
    dangerous("telinit 6", "telinit")
  })

  it("systemctl dangerous subcommands", () => {
    dangerous("systemctl poweroff", "systemctl poweroff")
    dangerous("systemctl --user reboot", "systemctl reboot")
  })

  it("dd to raw devices", () => {
    dangerous("dd if=/dev/zero of=/dev/sda bs=1M", "dd")
    dangerous("dd if=x of=/dev/disk2", "dd")
  })

  it("rm -rf in all shapes — target is irrelevant upstream", () => {
    dangerous("rm -rf /", "rm -rf")
    dangerous("rm -rf /tmp/build", "rm -rf")
    dangerous("rm -rf ./build", "rm -rf")
    dangerous("rm -fr dir", "rm -rf")
    dangerous("rm -r -f dir", "rm -rf")
    dangerous("rm -R --force dir", "rm -rf")
    dangerous("rm --recursive --force dir", "rm -rf")
    dangerous("rm -rfv dir", "rm -rf")
    dangerous("rm -rf $TARGET", "rm -rf")
  })

  it("privilege and launch wrappers are unwrapped", () => {
    dangerous("sudo reboot", "reboot")
    dangerous("sudo -u root reboot", "reboot")
    dangerous("doas rm -rf /", "rm -rf")
    dangerous("env rm -rf dir", "rm -rf")
    dangerous("env FOO=bar rm -rf dir", "rm -rf")
    dangerous("env -i FOO=bar shutdown now", "shutdown")
    dangerous("nohup rm -rf dir", "rm -rf")
    dangerous("exec reboot", "reboot")
    dangerous("command reboot", "reboot")
    dangerous("builtin shutdown now", "shutdown")
    dangerous("nice -n 5 poweroff", "poweroff")
    dangerous("nice --adjustment=5 shutdown now", "shutdown")
    dangerous("nohup nice sudo rm -rf /", "rm -rf")
  })

  it("nested shells and eval", () => {
    dangerous('bash -c "shutdown now"', "shutdown")
    dangerous("bash -lc \"shutdown now\"", "shutdown")
    dangerous("zsh -c 'rm -rf /'", "rm -rf")
    dangerous('bash -c "bash -c \'shutdown\'"', "shutdown")
    dangerous('eval "shutdown now"', "shutdown")
    dangerous("eval rm -rf dir", "rm -rf")
    dangerous('bash -c "env rm -rf dir"', "rm -rf")
    dangerous("bash -c 'eval \"shutdown now\"'", "shutdown")
    dangerous("bash --noprofile -c 'shutdown now'", "shutdown")
    dangerous("bash -O extglob -c 'reboot'", "reboot")
  })

  it("busybox applets", () => {
    dangerous("busybox poweroff", "poweroff")
    dangerous("busybox rm -rf dir", "rm -rf")
  })

  it("command name normalization", () => {
    dangerous("/bin/rm -rf /", "rm -rf")
    // Upstream checks force with case-sensitive lowercase 'f' (recursive
    // accepts both 'r' and 'R') — 'RM -RF' therefore does NOT match.
    dangerous("RM -rf /", "rm -rf")
    dangerous("rm.exe -rf /", "rm -rf")
  })

  it("commands inside compound constructs — every segment analyzed", () => {
    dangerous("echo ok && shutdown now", "shutdown")
    dangerous("if halt; then echo x; fi", "halt")
    dangerous("for i in 1 2; do rm -rf /; done", "rm -rf")
    dangerous("echo hi | sudo reboot", "reboot")
    dangerous("while true; do shutdown; done", "shutdown")
    dangerous("echo $(rm -rf /)", "rm -rf")
  })

  it("nested-shell depth boundary (eval chain)", () => {
    dangerous("eval eval eval eval shutdown", "shutdown")
    unanalyzable("eval eval eval eval eval shutdown")
  })
})

describe("unanalyzable commands (fail-safe)", () => {
  it("un-literal command name", () => {
    unanalyzable("$CMD --force")
  })

  it("nested shell payload that is not fully literal", () => {
    unanalyzable('bash -c "echo $HOME"')
  })

  it("malformed input", () => {
    unanalyzable('echo "unterminated')
  })

  it("budget exhaustion degrades to unanalyzable (deterministic node cap)", () => {
    const bomb = "echo a; ".repeat(3_000)
    const verdict: DangerousVerdict | undefined = analyzeCommandString(bomb)
    expect(verdict).toEqual({ kind: "unanalyzable" })
  })
})

describe("analyzeCommandString never throws", () => {
  it("empty and weird inputs", () => {
    expect(() => analyzeCommandString("")).not.toThrow()
    expect(() => analyzeCommandString("  \n\t ")).not.toThrow()
    expect(() => analyzeCommandString("\u0000\u0001")).not.toThrow()
    expect(() => analyzeCommandString("#".repeat(100_000))).not.toThrow()
  })
})
