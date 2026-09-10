import path from "node:path";
import { describe, it } from "vitest";
import { allow, ask, root } from "./helpers";

describe("cwd normalization", () => {
  it("propagates cwd only through one exact literal cd && command", () => {
    allow("cd /tmp && cat hosts");
    ask("cd /tmp && rm x");
    allow("cd sub && echo x > out");
    allow("cd sub && rm -rf .");
    ask("cd sub | rm -rf .");
    ask("cd missing || rm -rf .");
    ask("cd missing; rm -rf .");
    ask("cd sub\nrm -rf .");
    ask("cd a; cd b; ls");
    ask("cd $DIR && ls");
    ask('echo "$(cd sub && date)"');
  });

  it("resolves from cwd while retaining the workspace boundary", () => {
    allow("rm -rf .", {}, path.join(root, "sub"));
    ask("rm -rf ..", {}, path.join(root, "sub"));
    allow(
      "./scripts/check",
      { "sub/scripts/check": "clean" },
      path.join(root, "sub"),
    );
    ask(
      "./scripts/check",
      { "sub/scripts/check": "dirty" },
      path.join(root, "sub"),
    );
  });
});
