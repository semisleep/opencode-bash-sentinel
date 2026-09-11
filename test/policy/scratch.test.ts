import { describe, expect, it } from "vitest";
import { isScratchDescendant, isScratchRoot } from "../../src/policy/scratch";
import {
  analyzeWorkspacePolicy,
  type WorkspaceContext,
} from "../../src/workspace-policy";

const home = "/home/dev";
const SCRATCH = ["/tmp", "/private/tmp", "/var/folders/xq/AbC/T"];

describe("isScratchDescendant / isScratchRoot", () => {
  it("matches only strict descendants of a scratch root", () => {
    expect(isScratchDescendant("/tmp/out.txt", SCRATCH)).toBe(true);
    expect(isScratchDescendant("/tmp/a/b", SCRATCH)).toBe(true);
    expect(isScratchDescendant("/private/tmp/x", SCRATCH)).toBe(true);
    expect(isScratchDescendant("/var/folders/xq/AbC/T/agent", SCRATCH)).toBe(
      true,
    );
    expect(isScratchDescendant("/tmp", SCRATCH)).toBe(false);
    expect(isScratchDescendant("/tmpfoo/x", SCRATCH)).toBe(false);
    expect(isScratchDescendant("/etc/out", SCRATCH)).toBe(false);
    expect(isScratchRoot("/tmp", SCRATCH)).toBe(true);
    expect(isScratchRoot("/tmp/x", SCRATCH)).toBe(false);
  });

  it("strips trailing separators but keeps exact case", () => {
    expect(isScratchDescendant("/tmp/out/", SCRATCH)).toBe(true);
    expect(isScratchDescendant("/tmp//out", SCRATCH)).toBe(true);
    expect(isScratchDescendant("/tmp/./out", SCRATCH)).toBe(true);
    expect(isScratchRoot("/tmp/", SCRATCH)).toBe(true);
    expect(isScratchRoot("/tmp//", SCRATCH)).toBe(true);
    expect(isScratchRoot("/tmp/.", SCRATCH)).toBe(true);
    // Allow-direction matching is exact-case: "/TMP" is not "/tmp" on a
    // case-sensitive filesystem, so a case-varied spelling must not allow.
    expect(isScratchDescendant("/TMP/out", SCRATCH)).toBe(false);
    expect(isScratchDescendant("/Private/Tmp/x", SCRATCH)).toBe(false);
    expect(isScratchRoot("/Private/Tmp", SCRATCH)).toBe(false);
  });

  it("an empty or absent list matches nothing", () => {
    expect(isScratchDescendant("/tmp/x")).toBe(false);
    expect(isScratchDescendant("/tmp/x", [])).toBe(false);
    expect(isScratchRoot("/tmp", [])).toBe(false);
    expect(isScratchRoot("/tmp")).toBe(false);
  });
});

describe("scratch allowance via policy (ADR-0004)", () => {
  function ctx(scratchRoots?: readonly string[]): WorkspaceContext {
    return {
      workspace: "/work/project",
      cwd: "/work/project",
      homedir: home,
      baseline: { status: () => "clean" },
      extraSensitiveRoots: [],
      ...(scratchRoots ? { scratchRoots } : {}),
    };
  }
  const act = (source: string, scratch?: readonly string[]) =>
    analyzeWorkspacePolicy(source, ctx(scratch)).action;

  it("allows recognized scratch mutations", () => {
    expect(act("strings /bin/ls > /tmp/s.txt", SCRATCH)).toBe("allow");
    expect(act("cp /etc/hosts /tmp/out", SCRATCH)).toBe("allow");
    expect(act("sed -i 's/a/b/' /tmp/draft", SCRATCH)).toBe("allow");
    expect(act("rm -rf /tmp/build-probe", SCRATCH)).toBe("allow");
    expect(act("mv /tmp/a /tmp/b", SCRATCH)).toBe("allow");
    expect(act("cat /etc/hosts > /tmp/leak", SCRATCH)).toBe("allow");
    expect(act("rm -rf /var/folders/xq/AbC/T/agent", SCRATCH)).toBe("allow");
    expect(act("strings /bin/ls > /private/tmp/s.txt", SCRATCH)).toBe("allow");
  });

  it("keeps the scratch-root deletion red line", () => {
    const decision = analyzeWorkspacePolicy("rm -rf /tmp", ctx(SCRATCH));
    expect(decision.action).toBe("ask");
    expect(decision.reason).toBe("scratch root removal");
    expect(act("mv /tmp /tmp2", SCRATCH)).toBe("ask");
    expect(act("rm -rf /private/tmp", SCRATCH)).toBe("ask");
    // Trailing separators must not turn the root into a "descendant".
    expect(act("rm -rf /tmp/", SCRATCH)).toBe("ask");
    expect(act("rm -rf /tmp//", SCRATCH)).toBe("ask");
    expect(act("rm -rf /private/tmp/", SCRATCH)).toBe("ask");
  });

  it("does not allow case-varied or root-equal spellings", () => {
    expect(act("rm -rf /TMP/x", SCRATCH)).toBe("ask");
    expect(act("strings /bin/ls > /Private/Tmp/x", SCRATCH)).toBe("ask");
    // A bare trailing-slash destination is the root itself, not a
    // descendant: directory-destination expansion is not modeled, so this
    // stays fail-closed (cp /etc/hosts /tmp/out and /tmp/dir/ still allow).
    expect(act("cp /etc/hosts /tmp/", SCRATCH)).toBe("ask");
    expect(act("cp /etc/hosts /tmp/dir/", SCRATCH)).toBe("allow");
  });

  it("keeps mixed and outside-scratch mutations asking", () => {
    expect(act("mv /etc/passwd /tmp/x", SCRATCH)).toBe("ask");
    expect(act("mv /tmp/x /etc/passwd", SCRATCH)).toBe("ask");
    expect(act("strings /bin/ls > /etc/out", SCRATCH)).toBe("ask");
    expect(act("rm -rf /var/tmp/x", SCRATCH)).toBe("ask");
    expect(act("rm -rf /tmp/*", SCRATCH)).toBe("ask");
  });

  it("lets the sensitive-read red line prevail over scratch", () => {
    const decision = analyzeWorkspacePolicy(
      "cp ~/.ssh/id_rsa /tmp/leak",
      ctx(SCRATCH),
    );
    expect(decision.action).toBe("ask");
    expect(decision.reason).toBe("sensitive external read");
    expect(act("cat ~/.ssh/id_rsa > /tmp/leak", SCRATCH)).toBe("ask");
  });

  it("does not touch execution trust or unrecognized forms", () => {
    expect(act("sh /tmp/x.sh", SCRATCH)).toBe("ask");
    expect(act("find /tmp -delete", SCRATCH)).toBe("ask");
  });

  it("keeps ordinary external reads unchanged", () => {
    expect(act("cat /etc/hosts", SCRATCH)).toBe("allow");
    expect(act("cat ~/.ssh/id_rsa", SCRATCH)).toBe("ask");
  });

  it("reproduces pre-ADR behavior with an empty or absent list", () => {
    expect(act("strings /bin/ls > /tmp/s.txt", [])).toBe("ask");
    expect(act("rm -rf /tmp/a", [])).toBe("ask");
    expect(act("strings /bin/ls > /tmp/s.txt")).toBe("ask");
    expect(act("cp /etc/hosts /tmp/out", [])).toBe("ask");
  });
});
