import { describe, expect, it } from "vitest";
import { analyzeWorkspacePolicy } from "../../src/workspace-policy";
import {
  scratchMutationVerdict,
  sensitiveVerdict,
} from "../../src/policy/path-domain";
import { context } from "./helpers";

const WORKSPACE = "/work/project";

function ctx(overrides: { scratch?: readonly string[]; sensitive?: readonly string[] } = {}) {
  return {
    ...context(),
    ...(overrides.scratch ? { scratchRoots: overrides.scratch } : {}),
    ...(overrides.sensitive ? { extraSensitiveRoots: overrides.sensitive } : {}),
  };
}

describe("path-domain predicates (ADR-0005)", () => {
  it("sensitiveVerdict owns the ADR-0002 external read rule", () => {
    expect(sensitiveVerdict("/home/dev/.ssh/id_rsa", ctx())).toEqual({
      allow: false,
      reason: "sensitive external read",
    });
    expect(sensitiveVerdict("/etc/hosts", ctx()).allow).toBe(true);
    expect(
      sensitiveVerdict("/srv/secret/key", ctx({ sensitive: ["/srv/secret"] }))
        .allow,
    ).toBe(false);
  });

  it("scratchMutationVerdict owns the ADR-0004 mutation rule", () => {
    const withScratch = ctx({ scratch: ["/tmp", "/private/tmp"] });
    expect(scratchMutationVerdict("/tmp/probe.ts", withScratch).allow).toBe(
      true,
    );
    expect(scratchMutationVerdict("/tmp", withScratch)).toEqual({
      allow: false,
      reason: "external write or unsupported external operation",
    });
    expect(scratchMutationVerdict("/etc/out", withScratch).allow).toBe(false);
    expect(scratchMutationVerdict("/tmp/x", ctx({ scratch: [] })).allow).toBe(
      false,
    );
  });

  it("an empty scratch list reproduces the pre-ADR-0004 verdicts", () => {
    const noScratch = ctx({ scratch: [] });
    expect(scratchMutationVerdict("/tmp/x", noScratch).allow).toBe(false);
    expect(analyzeWorkspacePolicy("strings /bin/ls > /tmp/f", noScratch).action).toBe("ask");
  });
});

describe("bash column of the cross-gate matrix", () => {
  const matrix: Array<{
    path: string;
    read: "allow" | "ask";
    mutate: "allow" | "ask";
  }> = [
    { path: `${WORKSPACE}/src/app.ts`, read: "allow", mutate: "allow" },
    { path: `${WORKSPACE}/.git/config`, read: "allow", mutate: "ask" },
    { path: "/tmp/matrix.ts", read: "allow", mutate: "allow" },
    { path: "/tmp/co/.git/config", read: "allow", mutate: "allow" },
    { path: "/tmp", read: "allow", mutate: "ask" },
    { path: "/srv/secret/key", read: "ask", mutate: "ask" },
    { path: "/etc/hosts", read: "allow", mutate: "ask" },
    { path: "/home/dev/notes.txt", read: "allow", mutate: "ask" },
  ];
  const withScratch = ctx({ scratch: ["/tmp", "/private/tmp"], sensitive: ["/srv/secret"] });

  it("read and mutation verdicts match the matrix on every path class", () => {
    for (const { path, read, mutate } of matrix) {
      expect(analyzeWorkspacePolicy(`cat ${path}`, withScratch).action, `read ${path}`).toBe(read);
      expect(
        analyzeWorkspacePolicy(`strings /bin/ls > ${path}`, withScratch).action,
        `mutate ${path}`,
      ).toBe(mutate);
    }
  });
});
