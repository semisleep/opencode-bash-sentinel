import { describe, expect, it } from "vitest";
import { allow, ask, context } from "../policy/helpers";
import { analyzeWorkspacePolicy } from "../../src/workspace-policy";

describe("unzip profile", () => {
  it("allows archive listing and stdout forms", () => {
    allow("unzip -l /work/project/build.zip");
    allow("unzip -v /work/project/build.zip");
    allow("unzip -l -v /work/project/build.zip");
    allow("unzip -l /work/project/build.zip | head -50");
    allow('unzip -l "/Users/guest/Downloads/report a.zip" | head -50');
    allow("unzip -p /work/project/notes.zip");
    allow('unzip -p /work/project/master.zip "src/*.ts"');
    allow("unzip -l /work/project/a.zip '*.md'");
    allow("unzip -l ~/Downloads/build.zip");
  });

  it("allows usage and version forms", () => {
    allow("unzip");
    allow("unzip -v");
    allow("unzip -h");
  });

  it("allows extraction with an explicit -d target", () => {
    allow("unzip -o /work/project/app.zip -d /work/project/out");
    allow("unzip /work/project/app.zip -d out");
    allow("unzip -n -q /work/project/app.zip -d /work/project/sub/out");
    allow('unzip -o /work/project/app.zip "ppt/slides/*" -d /work/project/out');
    allow("unzip /work/project/app.zip member.txt -d out");
    // Mixed source/destination stays whole (§4): the external archive read
    // puts the unit outside, and the workspace write recovers no allow.
    ask("unzip -o ~/Downloads/app.zip -d /work/project/out");
  });

  it("asks for implicit writes and unknown or malformed shapes", () => {
    // No -d: unzip would scatter derived writes into the cwd.
    ask("unzip /work/project/app.zip");
    ask("unzip -o /work/project/app.zip");
    ask('unzip /work/project/app.zip "*.txt"');
    // A mode without its archive, or a bare extract flag.
    ask("unzip -l");
    ask("unzip -p");
    ask("unzip -o");
    // Cousin modes and clustered or unknown flags.
    ask("unzip -t /work/project/app.zip");
    ask("unzip -Z1 /work/project/app.zip");
    ask("unzip -lo /work/project/app.zip");
    ask("unzip -c /work/project/app.zip");
    ask('unzip -l /work/project/app.zip -x "*.log"');
    // -d value violations.
    ask("unzip -o /work/project/app.zip -d");
    ask("unzip -o /work/project/app.zip -d -x");
    ask("unzip -o /work/project/app.zip -d a -d b");
    // Contradictory modes.
    ask("unzip -l -p /work/project/app.zip");
    ask("unzip -l /work/project/app.zip -d out");
    ask("unzip -p /work/project/app.zip -d out");
    // A flag from the wrong family riding along.
    ask("unzip -q -l /work/project/app.zip");
    // Dynamic operands.
    ask("unzip $ZIP");
    ask('unzip -l "$(pwd)/a.zip"');
  });

  it("routes the -d write through the write situation and red lines", () => {
    ask("unzip -o /work/project/app.zip -d /etc/unz");
    ask("unzip -o /work/project/app.zip -d ../outside");
    ask("unzip -o /work/project/app.zip -d /work/project/.git/hooks");
    ask("unzip -l /home/dev/.ssh/keys.zip");
    ask("unzip -o /work/project/app.zip -d out && rm -rf .git");
    ask("unzip -l /work/project/app.zip; git push");
  });

  it("allows scratch-root targets (ADR-0004 strict descendants)", () => {
    const ctx = { ...context(), scratchRoots: ["/work/scratch"] };
    expect(
      analyzeWorkspacePolicy(
        "unzip -o /work/project/app.zip -d /work/scratch/unz",
        ctx,
      ).action,
      "strict scratch descendant allows",
    ).toBe("allow");
    expect(
      analyzeWorkspacePolicy(
        "unzip -o /work/project/app.zip -d /work/scratch",
        ctx,
      ).action,
      "the scratch root itself is not a strict descendant",
    ).toBe("ask");
    expect(
      analyzeWorkspacePolicy(
        'unzip -o "/Users/guest/Downloads/app.zip" -d /work/scratch/unz',
        ctx,
      ).action,
      "external archive read plus scratch mutation allows",
    ).toBe("allow");
  });
});
