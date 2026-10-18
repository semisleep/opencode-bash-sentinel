import { describe, it } from "vitest";
import { allow, ask } from "../policy/helpers";

describe("opencode profile", () => {
  it("allows the closed usage surface", () => {
    allow("opencode --version");
    allow("opencode --version 2>/dev/null");
    allow("opencode --help");
    allow("opencode -h");
    allow("opencode -V");
    allow("opencode --help --version");
    allow("opencode run --help");
    allow("opencode serve --help");
    allow("opencode run --help 2>&1 | head -40");
  });

  it("keeps execution and mutation shapes out", () => {
    ask("opencode");
    ask("opencode run --agent build \"CMD:git status\"");
    ask("opencode run --standalone \"CMD:echo x > probe\"");
    ask("opencode serve");
    ask("opencode auth login");
    ask("opencode upgrade");
    ask("opencode api get session.list");
    ask("opencode --print-logs");
    ask("opencode run --help --agent build");
    ask("opencode nosuchsub --help");
    ask("opencode run --help extra");
    ask("opencode --version && rm -rf .git");
    ask("opencode $OCFLAG");
  });
});
