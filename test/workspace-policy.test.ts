import { describe, expect, it } from "vitest"
import { analyzeWorkspacePolicy, defaultWorkspaceContext } from "../src/workspace-policy"

const ctx = defaultWorkspaceContext("/Users/dev/project")

const policy = (command: string) => analyzeWorkspacePolicy(command, ctx)

const safe = (command: string) => expect(policy(command).verdict).toBeUndefined()

const dangerous = (command: string) => expect(policy(command).verdict?.kind).toBe("dangerous")

const WS = "/Users/dev/project"
const HOME = process.platform === "win32" ? "C:\\Users\\dev" : "/Users/dev"

describe("rm targets", () => {
  it("inside workspace auto-approved regardless of flags", () => {
    safe("rm file.txt")
    safe("rm -rf build")
    safe("rm -rf ./build/node_modules")
    safe(`rm -rf ${WS}/dist`)
    safe("rm -r --force sub")
  })

  it("outside workspace escalates", () => {
    dangerous(`rm /tmp/x`)
    dangerous(`rm ${HOME}/.zshrc`)
    dangerous(`rm -rf /private/tmp/y`)
    dangerous(`rm ${WS}/../neighbor/x`)
  })

  it("workspace/home/system roots escalate even though 'inside'", () => {
    dangerous(`rm -rf ${WS}`)
    dangerous(`rm -rf ${WS}/`)
    dangerous(`rm -rf ${HOME}`)
    dangerous("rm -rf /")
  })

  it("unresolvable targets escalate (fail-safe)", () => {
    dangerous("rm $TARGET")
    dangerous("rm -rf $HOME/important")
    dangerous("rm *.log")
    dangerous("rm -rf $(pwd)")
  })

  it(".git paths escalate", () => {
    dangerous("rm -rf .git")
    dangerous(`rm ${WS}/.git/config`)
    dangerous("rm -rf sub/.git")
    dangerous("rm .GIT/hooks")
  })

  it("wrappers are unwrapped", () => {
    dangerous("sudo rm /tmp/x")
    dangerous("sudo rm -rf /Users/dev/project") // root target
    safe("sudo rm build")
    dangerous("env VAR=1 rm ~/.zshrc")
  })

  it("rm with no targets is a no-op", () => {
    safe("rm")
    safe("rm -rf")
  })
})

describe("write redirects", () => {
  it("outside workspace or unresolvable escalate", () => {
    dangerous("echo x > /tmp/out")
    dangerous("echo x >> /tmp/out")
    dangerous("echo x > ~/.zshrc")
    dangerous("cat in > $OUT")
    dangerous("echo x > $(mktemp)")
    dangerous("echo x 2> /tmp/err")
    dangerous("some-cmd &> /tmp/all")
  })

  it("inside workspace, relative, or device targets are fine", () => {
    safe("echo x > out.txt")
    safe("echo x >> logs/run.log")
    safe(`echo x > ${WS}/build/out.txt`)
    safe("cmd 2> /dev/null")
    safe("cmd > /dev/null 2>&1")
    safe("cmd < input.txt")
  })

  it(".git targets escalate", () => {
    dangerous("echo x > .git/config")
    dangerous(`echo x > ${WS}/.git/hooks/pre-commit`)
  })
})

describe("write-command table (external gate blind spots)", () => {
  it("sed -i", () => {
    safe("sed -i s/a/b/ file.txt")
    safe(`sed -i.bak s/a/b/ ${WS}/x`)
    safe("sed s/a/b/ /etc/hosts") // no -i: read-only
    dangerous("sed -i s/a/b/ /etc/hosts")
    dangerous("sed --in-place s/a/b/ /etc/hosts")
    dangerous("sed -i s/a/b/ $F")
  })

  it("dd of=", () => {
    safe("dd if=/dev/zero of=img bs=1k count=1")
    safe(`dd of=${WS}/tmp.img`)
    safe("dd if=/dev/zero of=/dev/null")
    dangerous("dd of=/tmp/img")
    dangerous("dd of=~/.bash_history")
    // raw /dev/* device targets are delegated to the upstream analyzer
    // (the plugin combines both verdicts), so the path policy itself passes them
    expect(analyzeWorkspacePolicy("dd if=x of=/dev/sda", ctx).verdict).toBeUndefined()
  })

  it("rsync / install / ln", () => {
    safe("rsync -a src/ dst/")
    dangerous("rsync -a src/ /tmp/backup/")
    safe("install -m 755 tool bin/tool")
    dangerous("install -m 755 tool /usr/local/bin/tool")
    safe("ln -s target linkname")
    dangerous("ln -s target /usr/local/bin/link")
  })

  it("tee / truncate / shred", () => {
    safe("cat x | tee out.log")
    dangerous("cat x | tee /tmp/out.log")
    safe("truncate -s 0 build/log")
    dangerous("truncate -s 0 /etc/x")
    safe("shred secret.tmp")
    dangerous("shred /tmp/secret")
  })
})

describe("inline-code interpreters", () => {
  it("escalate on -c/-e style inline code", () => {
    dangerous("python -c 'print(1)'")
    dangerous("python3 -c 'print(1)'")
    dangerous("node -e 'console.log(1)'")
    dangerous("node --eval 'x'")
    dangerous("node -p '1+1'")
    dangerous("ruby -e 'puts 1'")
    dangerous("perl -e 'print 1'")
    dangerous("php -r 'echo 1;'")
    dangerous("sudo python -c 'x'")
  })

  it("running files and modules is allowed", () => {
    safe("python script.py")
    safe("node server.js")
    safe("python -m pip install x")
    safe("ruby script.rb --flag")
  })

  it("osascript always escalates", () => {
    dangerous("osascript -e 'tell app \"Finder\" to activate'")
    dangerous("osascript script.scpt")
  })
})

describe("find / xargs escape hatches", () => {
  it("find -delete and -exec escalate", () => {
    safe("find . -name '*.ts'")
    safe("find src -type f")
    dangerous("find . -name '*.log' -delete")
    dangerous("find / -exec rm {} ;")
    dangerous("find . -execdir sh -c 'x' ;")
  })

  it("xargs invoking write-capable commands escalates", () => {
    dangerous("git ls-files | xargs rm")
    dangerous("ls | xargs chmod 644")
    dangerous("cat list | xargs -I {} sed -i s/a/b/ {}")
    dangerous("find . | xargs sh -c 'echo $0'")
    safe("git ls-files | xargs cat")
    safe("ls | xargs wc -l")
  })
})

describe("cd + relative write combination", () => {
  it("cd outside then relative write escalates", () => {
    dangerous("cd /tmp && echo x > out")
    dangerous("cd /tmp && rm file")
    dangerous("cd ~ && tee out.log")
    dangerous("cd $DIR && rm x")
    safe("cd") // bare cd changes cwd only; no write combined
  })

  it("cd inside workspace with writes is fine", () => {
    safe("cd sub && echo x > out")
    safe(`cd ${WS}/build && rm -rf .`)
    safe("cd sub && cat ../x > y")
  })

  it("cd outside with reads only is fine", () => {
    safe("cd /etc && ls")
    safe("cd /tmp && cat x")
  })
})

describe("compound and nested commands", () => {
  it("every segment analyzed", () => {
    dangerous("cat /etc/hosts; sed -i s/a/b/ /etc/hosts")
    dangerous("echo ok && rm /tmp/x")
    dangerous("cat /etc/hosts | tee /tmp/x")
  })

  it("nested shells and eval", () => {
    dangerous("sh -c 'rm /tmp/x'")
    dangerous("bash -c \"python -c 'x'\"")
    dangerous("eval 'echo x > /tmp/y'")
    safe("bash -c 'rm build'")
    safe("eval 'cat /etc/hosts'")
  })

  it("command substitution bodies are analyzed", () => {
    dangerous("echo $(rm /tmp/x)")
    dangerous("echo start $(sed -i s/a/b/ /etc/hosts) end")
  })

  it("external read + internal write is safe", () => {
    safe("cat /etc/hosts > out.txt")
    safe("rg foo ${HOME}/logs > result.txt")
  })
})

describe("rmHandled suppression contract", () => {
  it("in-workspace rm marks rmHandled so the plugin can suppress the upstream rm -rf verdict", () => {
    const result = policy("rm -rf build")
    expect(result.verdict).toBeUndefined()
    expect(result.rmHandled).toBe(true)
  })

  it("escalated rm also marks rmHandled (upstream verdict irrelevant then)", () => {
    const result = policy("rm -rf /tmp/x")
    expect(result.rmHandled).toBe(true)
    expect(result.verdict?.kind).toBe("dangerous")
  })

  it("commands without rm do not mark it", () => {
    expect(policy("git status").rmHandled).toBe(false)
    expect(policy("echo x > /tmp/y").rmHandled).toBe(false)
  })
})

describe("parse failures degrade safely", () => {
  it("malformed input is unanalyzable", () => {
    expect(policy('echo "unterminated').verdict).toEqual({ kind: "unanalyzable" })
  })
})
