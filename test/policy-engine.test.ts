import { describe, expect, it } from "vitest";
import { analyzeCommandPolicy, analyzeCommandString } from "../src/policy-engine";
import type { WorkspaceContext } from "../src/workspace-policy";

const ctx: WorkspaceContext = {
  workspace: "/work/project",
  cwd: "/work/project",
  homedir: "/home/dev",
  baseline: { status: () => "clean" },
};
describe("permission gates", () => {
  it("uses exactly the same policy for bash and external_directory", () => {
    for (const source of [
      "cat /etc/hosts",
      "echo x > out",
      "rm /tmp/x",
      "unknown",
    ]) {
      expect(analyzeCommandPolicy(source, ctx, { gate: "bash" })).toEqual(
        analyzeCommandPolicy(source, ctx, { gate: "external_directory" }),
      );
    }
  });
  it("exposes fail-closed reasons", () => {
    expect(analyzeCommandPolicy("unknown", ctx)).toMatchObject({
      action: "ask",
      verdict: { kind: "unanalyzable" },
    });
  });
  it("keeps the public string-analysis compatibility entry point on the new policy", () => {
    expect(analyzeCommandString("git status", ctx)).toBeUndefined();
    expect(analyzeCommandString("unknown", ctx)).toEqual({
      kind: "unanalyzable",
    });
  });
});
