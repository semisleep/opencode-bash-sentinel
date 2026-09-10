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
): WorkspaceContext {
  const root = path.normalize(workspace);
  return {
    workspace: root,
    cwd: path.normalize(cwd),
    homedir: os.homedir(),
    baseline: new GitBaseline(root),
  };
}

class GitBaseline implements BaselineInspector {
  constructor(private workspace: string) {}

  status(file: string): BaselineStatus {
    if (!withinWorkspace(file, this.workspace)) return "unknown";
    const relative = path
      .relative(this.workspace, file)
      .replaceAll(path.sep, "/");
    if (!relative || relative.startsWith("../")) return "unknown";
    try {
      execFileSync(
        "git",
        ["-C", this.workspace, "cat-file", "-e", `HEAD:${relative}`],
        { stdio: "ignore", timeout: 1_000 },
      );
    } catch {
      return "absent";
    }
    try {
      execFileSync(
        "git",
        [
          "-C",
          this.workspace,
          "diff",
          "--quiet",
          "--no-ext-diff",
          "--no-textconv",
          "HEAD",
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
}
