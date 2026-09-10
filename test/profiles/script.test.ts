import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  analyzeWorkspacePolicy,
  defaultWorkspaceContext,
} from "../../src/workspace-policy";
import { allow, ask } from "../policy/helpers";

describe("workspace script profile", () => {
  it("requires a clean committed entry and acceptable visible arguments", () => {
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

  it("checks the real Git HEAD and worktree", () => {
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

  it("rejects mutation/dependency conflicts without order reasoning", () => {
    ask("sed -i 's/a/b/' scripts/check && ./scripts/check");
    ask("./scripts/check && sed -i 's/a/b/' scripts/check");
  });
});
