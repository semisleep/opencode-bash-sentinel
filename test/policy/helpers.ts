import path from "node:path";
import { expect } from "vitest";
import {
  analyzeWorkspacePolicy,
  type BaselineStatus,
  type WorkspaceContext,
} from "../../src/workspace-policy";

export const root = "/work/project";

export function context(
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

export function decision(
  source: string,
  overrides: Record<string, BaselineStatus> = {},
  cwd: string = root,
) {
  return analyzeWorkspacePolicy(source, context(overrides, cwd));
}

export function allow(
  source: string,
  overrides?: Record<string, BaselineStatus>,
  cwd?: string,
) {
  expect(decision(source, overrides, cwd).action, source).toBe("allow");
}

export function ask(
  source: string,
  overrides?: Record<string, BaselineStatus>,
  cwd?: string,
) {
  expect(decision(source, overrides, cwd).action, source).toBe("ask");
}
