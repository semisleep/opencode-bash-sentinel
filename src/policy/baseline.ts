import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { withinWorkspace } from "./paths";
import type {
  BaselineInspector,
  BaselineStatus,
  WorkspaceContext,
} from "./types";

export function defaultWorkspaceContext(
  workspace: string,
  cwd: string = workspace,
  extraSensitiveRoots: readonly string[] = [],
  scratchRoots: readonly string[] = [],
): WorkspaceContext {
  const root = path.normalize(workspace);
  return {
    workspace: root,
    cwd: path.normalize(cwd),
    homedir: os.homedir(),
    baseline: new GitBaseline(root),
    extraSensitiveRoots,
    scratchRoots,
  };
}

class GitBaseline implements BaselineInspector {
  private readonly baselineRef: string | undefined;

  constructor(private workspace: string) {
    try {
      this.baselineRef = execFileSync(
        "git",
        ["-C", this.workspace, "rev-parse", "--verify", "HEAD"],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 1_000,
        },
      ).trim();
    } catch {
      this.baselineRef = undefined;
    }
  }

  status(file: string): BaselineStatus {
    if (!withinWorkspace(file, this.workspace)) return "unknown";
    if (!this.baselineRef) return "unknown";
    const relative = this.relative(file);
    if (!relative) return "unknown";
    try {
      execFileSync(
        "git",
        [
          "-C",
          this.workspace,
          "cat-file",
          "-e",
          `${this.baselineRef}:${relative}`,
        ],
        { stdio: "ignore", timeout: 1_000 },
      );
    } catch {
      return "absent";
    }
    try {
      execFileSync(
        "git",
        [
          "--literal-pathspecs",
          "-C",
          this.workspace,
          "diff",
          "--cached",
          "--quiet",
          "--no-ext-diff",
          "--no-textconv",
          this.baselineRef,
          "--",
          relative,
        ],
        { stdio: "ignore", timeout: 1_000 },
      );
      execFileSync(
        "git",
        [
          "--literal-pathspecs",
          "-C",
          this.workspace,
          "diff",
          "--quiet",
          "--no-ext-diff",
          "--no-textconv",
          "--",
          relative,
        ],
        { stdio: "ignore", timeout: 1_000 },
      );
      return "clean";
    } catch {
      return "dirty";
    }
  }

  committedText(file: string): string | undefined {
    if (!this.baselineRef) return undefined;
    const relative = this.relative(file);
    if (!relative) return undefined;
    try {
      return execFileSync(
        "git",
        ["-C", this.workspace, "show", `${this.baselineRef}:${relative}`],
        {
          encoding: "utf8",
          timeout: 1_000,
          maxBuffer: 1_000_000,
        },
      );
    } catch {
      return undefined;
    }
  }

  private relative(file: string): string | undefined {
    if (!withinWorkspace(file, this.workspace)) return undefined;
    const relative = path
      .relative(this.workspace, file)
      .replaceAll(path.sep, "/");
    return !relative || relative.startsWith("../") ? undefined : relative;
  }
}
