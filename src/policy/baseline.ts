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

/**
 * ADR-0007: no commit is pinned. A file is clean when it is present in the
 * current HEAD and the index and worktree match HEAD for that path; HEAD is
 * resolved at each decision, so trust follows the current commit and a commit
 * takes effect at the next decision without a reload.
 */
class GitBaseline implements BaselineInspector {
  constructor(private workspace: string) {}

  status(file: string): BaselineStatus {
    if (!withinWorkspace(file, this.workspace)) return "unknown";
    const relative = this.relative(file);
    if (!relative) return "unknown";
    try {
      execFileSync(
        "git",
        ["-C", this.workspace, "cat-file", "-e", `HEAD:${relative}`],
        { stdio: "ignore", timeout: 1_000 },
      );
    } catch {
      // Distinguish "no repository / no HEAD" from "not in HEAD".
      return this.hasHead() ? "absent" : "unknown";
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
          "HEAD",
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
    const relative = this.relative(file);
    if (!relative) return undefined;
    try {
      return execFileSync(
        "git",
        ["-C", this.workspace, "show", `HEAD:${relative}`],
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

  private hasHead(): boolean {
    try {
      execFileSync(
        "git",
        ["-C", this.workspace, "rev-parse", "--verify", "HEAD"],
        { stdio: "ignore", timeout: 1_000 },
      );
      return true;
    } catch {
      return false;
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
