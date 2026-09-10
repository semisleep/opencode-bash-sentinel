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
    ask("./scripts/check --output=/tmp/result");
    ask("./scripts/check -o/tmp/result");
    allow("./scripts/check --output=build/result");
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

  it("does not let a later commit advance the session trust baseline", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "sentinel-session-"));
    try {
      writeFileSync(path.join(directory, "check.sh"), "#!/bin/sh\ntrue\n");
      const magicPath = path.join(directory, ":!check.sh");
      writeFileSync(magicPath, "#!/bin/sh\ntrue\n");
      execFileSync("git", ["init", "-q", directory]);
      execFileSync("git", ["-C", directory, "add", "--all"]);
      const commit = (message: string) =>
        execFileSync("git", [
          "-C",
          directory,
          "-c",
          "user.name=Sentinel Test",
          "-c",
          "user.email=sentinel@example.invalid",
          "commit",
          "-qm",
          message,
        ]);
      commit("baseline");
      const sessionContext = defaultWorkspaceContext(directory);
      writeFileSync(magicPath, "#!/bin/sh\necho changed\n");
      expect(sessionContext.baseline.status(magicPath)).toBe("dirty");
      const original = "#!/bin/sh\ntrue\n";
      const changed = `${original}echo changed\n`;
      writeFileSync(path.join(directory, "check.sh"), changed);
      execFileSync("git", ["-C", directory, "add", "check.sh"]);
      writeFileSync(path.join(directory, "check.sh"), original);
      expect(analyzeWorkspacePolicy("./check.sh", sessionContext).action).toBe(
        "ask",
      );
      writeFileSync(path.join(directory, "check.sh"), changed);
      commit("changed during session");

      expect(analyzeWorkspacePolicy("./check.sh", sessionContext).action).toBe(
        "ask",
      );
      expect(
        analyzeWorkspacePolicy("./check.sh", defaultWorkspaceContext(directory))
          .action,
      ).toBe("allow");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects mutation/dependency conflicts without order reasoning", () => {
    ask("sed -i 's/a/b/' scripts/check && ./scripts/check");
    ask("./scripts/check && sed -i 's/a/b/' scripts/check");
  });
});
