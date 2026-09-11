import { describe, expect, it } from "vitest";
import { isSensitiveTarget } from "../../src/policy/sensitive";
import {
  analyzeWorkspacePolicy,
  type WorkspaceContext,
} from "../../src/workspace-policy";

const home = "/home/dev";

describe("isSensitiveTarget", () => {
  it("matches a sensitive root and everything under it", () => {
    expect(isSensitiveTarget("/home/dev/.ssh", home)).toBe(true);
    expect(isSensitiveTarget("/home/dev/.ssh/id_rsa", home)).toBe(true);
    expect(isSensitiveTarget("/home/dev/.aws/credentials", home)).toBe(true);
    expect(isSensitiveTarget("/etc/shadow", home)).toBe(true);
    expect(isSensitiveTarget("/etc/ssl/private/server.key", home)).toBe(true);
  });

  it("matches case-insensitively, like the .git red line", () => {
    // macOS is case-insensitive; a case-varied root must not slip past.
    expect(isSensitiveTarget("/home/dev/.SSH/id_rsa", home)).toBe(true);
    expect(isSensitiveTarget("/home/dev/.Ssh", home)).toBe(true);
    expect(isSensitiveTarget("/ETC/shadow", home)).toBe(true);
    expect(isSensitiveTarget("/opt/VAULT/key", home, ["/opt/vault"])).toBe(true);
  });

  it("does not match siblings or unrelated paths", () => {
    expect(isSensitiveTarget("/home/dev/.sshfoo", home)).toBe(false);
    expect(isSensitiveTarget("/home/dev/.aws-notes", home)).toBe(false);
    expect(isSensitiveTarget("/etc/hosts", home)).toBe(false);
    expect(isSensitiveTarget("/etc/ssl/cert.pem", home)).toBe(false);
    expect(isSensitiveTarget("/home/dev/project/credentials", home)).toBe(false);
  });

  it("unions additive user roots without dropping defaults", () => {
    const extra = ["~/.config/secret-app", "/opt/vault"];
    expect(isSensitiveTarget("/home/dev/.config/secret-app/tok", home, extra)).toBe(true);
    expect(isSensitiveTarget("/opt/vault/key", home, extra)).toBe(true);
    // defaults still apply alongside the extras
    expect(isSensitiveTarget("/home/dev/.ssh/id_rsa", home, extra)).toBe(true);
  });
});

describe("sensitive external read red line via policy", () => {
  function ctx(extraSensitiveRoots: readonly string[] = []): WorkspaceContext {
    return {
      workspace: "/work/project",
      cwd: "/work/project",
      homedir: home,
      baseline: { status: () => "clean" },
      extraSensitiveRoots,
    };
  }
  const act = (source: string, extra?: readonly string[]) =>
    analyzeWorkspacePolicy(source, ctx(extra)).action;

  it("asks for a default sensitive read and reports the reason", () => {
    const decision = analyzeWorkspacePolicy("cat ~/.ssh/id_rsa", ctx());
    expect(decision.action).toBe("ask");
    expect(decision.reason).toBe("sensitive external read");
  });

  it("still allows an ordinary external read", () => {
    expect(act("cat /etc/hosts")).toBe("allow");
  });

  it("honors additive user-supplied roots", () => {
    expect(act("cat /opt/vault/key")).toBe("allow");
    expect(act("cat /opt/vault/key", ["/opt/vault"])).toBe("ask");
  });
});
