import { describe, it } from "vitest";
import { allow, ask } from "../policy/helpers";

describe("pgrep profile", () => {
  it("allows read-only process listing", () => {
    allow("pgrep sshd");
    allow("pgrep -x RetroArch");
    allow('pgrep -fl "ssh -f -N"');
    allow("pgrep -filon sshd");
    allow("pgrep -f ssh");
  });

  it("keeps the signalling sibling and value selectors out", () => {
    ask("pkill -x foo");
    ask("pgrep -P 1 sshd");
    ask("pgrep -u root");
    ask("pgrep -x");
    ask("pgrep");
    ask("pgrep --full sshd");
    ask("pgrep -fl sshd && rm -rf .git");
    ask("pgrep $PROC");
  });
});
