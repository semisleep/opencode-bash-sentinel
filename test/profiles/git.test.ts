import { describe, it } from "vitest";
import { allow, ask } from "../policy/helpers";

describe("git profile", () => {
  it("allows only reviewed subcommands and operand shapes", () => {
    allow("git status");
    allow("git diff HEAD");
    allow("git add file");
    allow("git commit -m 'message'");
    allow("git fetch --prune");
    allow("git fetch origin main");
    allow("git fetch https://example.com/org/repo.git main:incoming");
    allow("git -C /tmp/repo log --oneline");
    allow("git diff --check");
    allow("git diff --cached --check --stat");
    ask("git push");
    ask("git reset --hard");
    ask("git -c alias.x='!evil' x");
    ask("git -C /tmp/repo add file");
    ask("git diff --ext-diff");
    ask("git add --max-count=1 file");
    ask("git show --untracked-files=all");
    ask("git grep --open-files-in-pager=less pattern");
    ask("git fetch 'ext::sh -c touch% /tmp/out'");
    ask("git fetch helper::payload");
    ask("git fetch custom://example.com/repo");
    ask("git fetch --all origin");
  });
});
