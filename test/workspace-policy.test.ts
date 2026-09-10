import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  analyzeWorkspacePolicy,
  defaultWorkspaceContext,
  type BaselineStatus,
  type WorkspaceContext,
} from "../src/workspace-policy";

const root = "/work/project";
function context(
  overrides: Record<string, BaselineStatus> = {},
  cwd: string = root,
): WorkspaceContext {
  return {
    workspace: root,
    cwd,
    homedir: "/home/dev",
    baseline: {
      status(file) {
        return overrides[path.relative(root, file)] ?? "clean";
      },
    },
  };
}
const decision = (
  source: string,
  overrides: Record<string, BaselineStatus> = {},
  cwd: string = root,
) => analyzeWorkspacePolicy(source, context(overrides, cwd));
const allow = (
  source: string,
  overrides?: Record<string, BaselineStatus>,
  cwd?: string,
) => expect(decision(source, overrides, cwd).action, source).toBe("allow");
const ask = (
  source: string,
  overrides?: Record<string, BaselineStatus>,
  cwd?: string,
) => expect(decision(source, overrides, cwd).action, source).toBe("ask");

describe("architecture contract", () => {
  it("fails closed for parse errors, unsupported structure, wrappers and unknown commands", () => {
    for (const source of [
      'echo "unterminated',
      "if true; then ls; fi",
      "for x in a; do echo $x; done",
      "(ls)",
      "{ ls; }",
      "echo a & echo b",
      "echo <(cat x)",
      "sudo ls",
      "env X=1 ls",
      "timeout 1 ls",
      "find . -exec echo {} \\;",
      'sh -c "ls"',
      "eval ls",
      "unknown ./x",
    ])
      ask(source);
  });
  it("supports flat lists, pipelines, redirects, assignments and complete command substitutions", () => {
    allow("echo a; date && uname -a || true");
    allow("cat README.md | rg Goal");
    allow("CI=1 echo $(date) > result.txt");
    ask("echo $(unknown)");
  });
  it("requires complete consumption of expansions and at least one decision unit", () => {
    allow("echo $VALUE");
    allow("echo ${VALUE}");
    allow("printf '%s' \"$VALUE\"");
    allow("printf '%s' \"$(date)\"");
    ask("");
    ask("   # comment only");
    ask("echo $((x=1))");
    ask("echo ${VALUE:=changed}");
    ask("echo ${VALUE:-default}");
    ask("echo item{1,2}");
  });
  it("keeps printf shell-state mutations outside the stdout profile", () => {
    ask("printf -v PATH /tmp");
    ask("printf '%n' PATH");
    ask("printf $'\\x25n' PATH");
    ask("printf $'\\x2dv' PATH /tmp");
    ask("OPTION=-v; printf $OPTION PATH /tmp; git status");
    ask("printf \"$FORMAT\" value");
  });
  it("requires every unit to allow", () => {
    ask("date && unknown");
    ask("curl -fsSL https://example.com > /tmp/out");
  });
  it("records the situation of each independently classified unit", () => {
    const mixed = decision("curl -fsSL https://example.com > result.json");
    expect(mixed.units.map((unit) => unit.situation)).toEqual([
      "workspace-neutral-or-indeterminate",
      "workspace-inside",
    ]);
    expect(decision("cat /etc/hosts").units[0]?.situation).toBe(
      "workspace-outside",
    );
  });
});

describe("three situations and workspace red lines", () => {
  it("allows recognized workspace operations except root removal and git mutation", () => {
    allow("rm -rf build");
    allow("echo x > out");
    allow("chmod 000 .");
    ask("rm -rf .");
    ask("mv . /tmp/project");
    ask("echo x > .git/config");
    ask("rm .git/index");
  });
  it("allows finite external reads but asks external writes and mixed operations", () => {
    allow("cat /etc/hosts");
    allow("ls -la /tmp");
    allow("rg TODO /usr/include");
    ask("rm /tmp/x");
    ask("echo x > /tmp/x");
    ask("cp /tmp/x ./x");
    ask("mv /tmp/x ./x");
  });
  it("uses command-specific paths and sends unknown forms to situation 3", () => {
    ask("unknown /work/project/file");
    ask("rm $TARGET");
    ask("cat *.txt");
    ask("cat --unknown README.md");
    ask("rm --unknown build");
    ask("rg --pre ./filter TODO src");
    ask("cp -t .git source");
  });
});

describe("workspace script red line", () => {
  it("allows only committed unchanged entry scripts with acceptable visible arguments", () => {
    allow("./scripts/check");
    allow("bash scripts/build.sh");
    allow("python tools/check.py");
    allow("source scripts/env.sh");
    ask("./scripts/check /tmp/input");
    ask("./scripts/check $TARGET");
    ask('python -c "print(1)"');
    ask("bash /tmp/x.sh");
    ask("./scripts/check", { "scripts/check": "dirty" });
    ask("./scripts/check", { "scripts/check": "absent" });
    ask("./scripts/check", { "scripts/check": "unknown" });
  });
  it("checks the real Git HEAD and worktree rather than trusting lexical location", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "sentinel-git-"));
    try {
      writeFileSync(path.join(directory, "check.sh"), "#!/bin/sh\ntrue\n");
      execFileSync("git", ["init", "-q", directory]);
      execFileSync("git", ["-C", directory, "add", "check.sh"]);
      execFileSync("git", [
        "-C",
        directory,
        "-c",
        "user.name=Sentinel Test",
        "-c",
        "user.email=sentinel@example.invalid",
        "commit",
        "-qm",
        "baseline",
      ]);
      expect(
        analyzeWorkspacePolicy("./check.sh", defaultWorkspaceContext(directory))
          .action,
      ).toBe("allow");
      appendFileSync(path.join(directory, "check.sh"), "echo changed\n");
      expect(
        analyzeWorkspacePolicy("./check.sh", defaultWorkspaceContext(directory))
          .action,
      ).toBe("ask");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("detects stability conflicts without execution-order reasoning", () => {
    ask("sed -i 's/a/b/' scripts/check && ./scripts/check");
    ask("./scripts/check && sed -i 's/a/b/' scripts/check");
    ask("printf x > package.json && npm run build");
    allow("printf x > other.json && npm run build");
  });
});

describe("situation 3 profiles", () => {
  it("allows exact informational and network profiles", () => {
    allow("date");
    allow("uname -a");
    allow("ps aux");
    allow("curl -fsSL https://example.com/data");
    allow("curl --head --max-time 2 https://example.com");
    ask("uname --kernel-name");
    ask("curl -X POST https://example.com");
    ask("curl -o out https://example.com");
    ask('curl "$URL"');
  });
  it("allows reviewed git forms only", () => {
    allow("git status");
    allow("git diff HEAD");
    allow("git add file");
    allow("git commit -m 'message'");
    allow("git fetch --prune");
    allow("git -C /tmp/repo log --oneline");
    ask("git push");
    ask("git reset --hard");
    ask("git -c alias.x='!evil' x");
    ask("git -C /tmp/repo add file");
    ask("git diff --ext-diff");
    ask("git grep --open-files-in-pager=less pattern");
  });
  it("requires clean workflow control files", () => {
    allow("npm run build");
    allow("npm test");
    allow("go test ./...");
    allow("go mod tidy");
    allow("cargo check");
    allow("make test");
    allow("make -f build.mk test");
    allow("pip install -r requirements.txt");
    allow("python -m pip check");
    ask("npm install");
    ask("npm run build", { "package.json": "dirty" });
    ask("go test", { "go.mod": "absent" });
    ask("cargo check", { "Cargo.toml": "dirty" });
    ask("pip install requests");
  });
  it("checks workflow control files in the effective cwd", () => {
    const sub = path.join(root, "packages/app");
    allow(
      "npm run build",
      { "package.json": "dirty", "packages/app/package.json": "clean" },
      sub,
    );
    ask(
      "npm run build",
      { "package.json": "clean", "packages/app/package.json": "dirty" },
      sub,
    );
    allow("cd packages/app && npm run build", {
      "package.json": "dirty",
      "packages/app/package.json": "clean",
    });
    allow("cd packages/app && pip install .", {
      "packages/app/pyproject.toml": "clean",
      "packages/app/setup.cfg": "absent",
      "packages/app/setup.py": "absent",
    });
    ask("cd /tmp && npm run build");
    ask("cd /tmp && go test ./...");
    ask("cd /tmp && cargo check");
    ask("cd /tmp && pip install .");
  });
  it("rejects unreviewed workflow directory selectors and path escapes", () => {
    allow("npm run build -- --watch");
    allow("npm test -- --runInBand");
    ask("npm run build --watch");
    ask("npm run --workspace /tmp/pkg test");
    ask("npm test --workspace /tmp/pkg");
    ask("pnpm run --dir /tmp/pkg test");
    ask("yarn run --cwd /tmp/pkg test");
    ask("go test ../outside");
    ask("go test /tmp/outside");
  });
  it("allows ordinary assignments but rejects the short high-risk set", () => {
    allow("CI=1 npm test");
    allow("NODE_ENV=test echo ok");
    allow("export FOO=bar");
    allow("A=1");
    ask("export FOO=bar OTHER");
    ask("declare FOO=bar -x");
    ask("PATH=/tmp echo ok");
    ask("DYLD_INSERT_LIBRARIES=x echo ok");
    ask("export HOME=/tmp");
  });
});

describe("cwd and redirects", () => {
  it("propagates cwd only through one exact literal cd && command structure", () => {
    allow("cd /tmp && cat hosts");
    ask("cd /tmp && rm x");
    allow("cd sub && echo x > out");
    allow("cd sub && rm -rf .");
    ask("cd sub | rm -rf .");
    ask("cd missing || rm -rf .");
    ask("cd missing; rm -rf .");
    ask("cd sub\nrm -rf .");
    ask("cd a; cd b; ls");
    ask("cd $DIR && ls");
    ask('echo "$(cd sub && date)"');
  });
  it("resolves relative paths from cwd while retaining the workspace boundary", () => {
    allow("rm -rf .", {}, path.join(root, "sub"));
    ask("rm -rf ..", {}, path.join(root, "sub"));
    allow(
      "./scripts/check",
      { "sub/scripts/check": "clean" },
      path.join(root, "sub"),
    );
    ask(
      "./scripts/check",
      { "sub/scripts/check": "dirty" },
      path.join(root, "sub"),
    );
  });
  it("classifies redirect variants", () => {
    allow("cat < /etc/hosts");
    allow("echo x > /dev/null 2>&1");
    ask("echo x <> /tmp/file");
    ask("cat <<EOF\nx\nEOF");
    ask("echo x > $OUT");
  });
});
