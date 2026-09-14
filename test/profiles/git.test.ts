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
    allow("git diff a08bf3c -- src/plugin.ts");
    allow("git log --oneline -5 -- src/plugin.ts");
    allow("git show HEAD -- src/plugin.ts");
    ask("git push");
    ask("git reset --hard");
    ask("git -c alias.x='!evil' x");
    ask("git -C /tmp/repo add file");
    ask("git diff --ext-diff");
    allow("git status -- file");
    allow("git status --porcelain -- src index.ts");
    ask("git status --porcelain=v1");
    ask("git diff -- --raw");
    ask("git add --max-count=1 file");
    ask("git show --untracked-files=all");
    ask("git grep --open-files-in-pager=less pattern");
    ask("git fetch 'ext::sh -c touch% /tmp/out'");
    ask("git fetch helper::payload");
    ask("git fetch custom://example.com/repo");
    ask("git fetch --all origin");
  });

  it("allows read-only pickaxe inspection on history subcommands", () => {
    allow("git log --oneline -S '\"--stat\"' -- src/plugin.ts");
    allow("git log -Sfoo --oneline");
    allow("git log -G needle --oneline -- src/plugin.ts");
    allow("git diff -S token");
    allow("git show -Gneedle HEAD");
    allow("git log --pickaxe-regex -S foo --oneline");
    allow("git diff --pickaxe-all -S token");
    allow("git log -S --stat --oneline");
    allow("git log --pickaxe-regex");
    ask("git log -S");
    ask("git log -G");
    ask("git commit -S keyid -m x");
    ask("git add -S x");
    ask("git status -S x");
    ask("git fetch -S x");
    ask("git log -s");
  });

  it("allows display-only format options on log and show", () => {
    allow('git log --format="%h %ad %s" --date=short -3 86bfe67');
    allow("git log --date=iso -3");
    allow("git show --format=%h HEAD");
    ask("git diff --format=%h");
    ask("git log --format %h");
    ask("git status --date=short");
  });

  it("allows date-range filters on log and show", () => {
    allow('git log --oneline --since="2026-09-12 00:00" -- src/plugin.ts');
    allow("git log --since=1.week --until=yesterday");
    allow("git show --after=2026-09-01 --before=2026-09-12 HEAD");
    allow(
      "git log --format='%h %ad %s' --date=format:'%H:%M' --since='2026-09-12 00:00' -- src/plugin.ts",
    );
    ask("git diff --since=1.week");
    ask("git log --since");
    ask("git status --since=1.week");
  });

  it("allows read-only git check-ignore queries", () => {
    allow("git check-ignore -v .agents/skills/why-ask/cache.json");
    allow("git check-ignore --verbose src/foo.ts");
    allow("git check-ignore -n src/foo.ts");
    allow("git check-ignore -q src/foo.ts");
    allow("git check-ignore --no-index -z src/foo.ts");
    allow("git -C /tmp/repo check-ignore -v x");
    ask("git check-ignore --stdin");
    ask("git check-ignore -x src/foo.ts");
    ask("git check-ignore --quiet=always src/foo.ts");
  });

  it("allows merge filters on git log", () => {
    allow("git log --oneline hide_prefilled..main --merges");
    allow("git log --merges --oneline -5");
    allow("git log --no-merges --oneline");
    ask("git show --merges");
  });

  it("allows listing-only git branch forms", () => {
    allow("git branch");
    allow("git branch -a");
    allow("git branch --all");
    allow("git branch -r");
    allow("git branch -v");
    allow("git branch -vv");
    allow("git branch -av");
    allow("git branch --remotes");
    allow("git branch --verbose");
    allow("git branch --show-current");
    allow("git branch -a --format='%(refname:short)'");
    allow("git branch --list hide_prefilled");
    allow("git branch --list 'hide*'");
    allow("git -C /tmp/repo branch -a");
    ask("git branch hide_prefilled");
    ask("git branch -a hide_prefilled");
    ask("git branch -d hide_prefilled");
    ask("git branch -D hide_prefilled");
    ask("git branch -m renamed");
    ask("git branch -M renamed");
    ask("git branch -c copied");
    ask("git branch -C copied");
    ask("git branch -f topic main");
    ask("git branch --force topic");
    ask("git branch -u origin/main");
    ask("git branch --set-upstream-to=origin/main");
    ask("git branch --unset-upstream");
    ask("git branch --edit-description");
    ask("git branch --contains HEAD");
    ask("git branch -S x");
  });

  it("allows read-only git merge-base", () => {
    allow("git merge-base hide_prefilled main");
    allow("git merge-base --all main hide_prefilled");
    allow("git merge-base -a main hide_prefilled");
    allow("git merge-base --is-ancestor main hide_prefilled");
    allow("git merge-base --independent main hide_prefilled topic");
    allow("git merge-base --octopus main topic other");
    allow("git merge-base --fork-point main hide_prefilled");
    allow("git -C /tmp/repo merge-base main HEAD");
    ask("git merge-base");
    ask("git merge-base -x main");
    ask("git merge-base --exec cmd main");
  });

  it("allows read-only git stash inspection", () => {
    allow("git stash list");
    allow("git stash list | head -3");
    allow("git stash list --oneline");
    allow("git stash list -3");
    allow("git stash show");
    allow("git stash show --stat");
    allow("git stash show --name-only");
    allow("git -C /tmp/repo stash list");
    ask("git stash");
    ask("git stash -u");
    ask("git stash push");
    ask("git stash pop");
    ask("git stash apply");
    ask("git stash drop");
    ask("git stash clear");
    ask("git stash store -m message refs/stash");
    ask("git stash create");
    ask("git stash branch topic");
    ask("git stash save work-in-progress");
    ask("git stash list --exec cmd");
    ask("git stash show -x");
  });

  it("allows patch display and revision filters on history subcommands", () => {
    allow("git log -p -3");
    allow("git show -p HEAD");
    allow("git diff -p");
    allow("git log -u --oneline");
    allow("git log --patch --stat -3");
    allow("git log --abbrev-commit --oneline");
    allow("git log --reverse --oneline");
    allow("git log --follow --oneline -- src/a.ts");
    allow("git log --first-parent --oneline");
    allow("git log --author=dev --oneline");
    allow("git log --grep=cache --oneline");
    allow("git show --grep=cache HEAD");
    ask("git diff --author=x");
    ask("git log --author");
    ask("git log --author x --oneline");
    ask("git log -x");
  });

  it("allows the --no-pager global display flag", () => {
    allow("git --no-pager log --oneline");
    allow("git --no-pager -C /tmp/repo log --oneline");
    allow("git -C /tmp/repo --no-pager show --stat HEAD");
    ask("git --no-pager push");
    ask("git -C /tmp/repo -C /tmp log --oneline");
  });

  it("allows read-only git describe", () => {
    allow("git describe");
    allow("git describe --tags");
    allow("git describe --always HEAD");
    allow("git describe --abbrev=8 main");
    allow("git describe --match 'v*' main");
    ask("git describe --abbrev=x main");
    ask("git describe --abbrev main");
    ask("git describe --unknown");
  });

  it("allows listing-only git tag forms", () => {
    allow("git tag");
    allow("git tag -l");
    allow("git tag --list");
    allow("git tag --list 'v*'");
    allow("git tag -n");
    allow("git tag --sort=refname");
    allow("git -C /tmp/repo tag");
    ask("git tag v1.0");
    ask("git tag -d v1.0");
    ask("git tag -a v1.0 -m message");
    ask("git tag -f v1.0");
    ask("git tag -s v1.0");
    ask("git tag --contains HEAD");
  });

  it("allows listing-only git remote forms", () => {
    allow("git remote");
    allow("git remote -v");
    allow("git remote --verbose");
    ask("git remote add upstream https://example.com/x.git");
    ask("git remote remove origin");
    ask("git remote set-url origin git@host:x.git");
    ask("git remote show origin");
  });

  it("allows read-only git reflog inspection", () => {
    allow("git reflog");
    allow("git reflog show");
    allow("git reflog show main");
    ask("git reflog expire --all");
    ask("git reflog delete HEAD@{1}");
    ask("git reflog --unknown");
    ask("git reflog main");
  });

  it("allows read-only shortlog, count-objects, and cat-file", () => {
    allow("git shortlog");
    allow("git shortlog -sn main");
    allow("git shortlog --email");
    ask("git shortlog --unknown");
    allow("git count-objects -v");
    allow("git count-objects --verbose");
    ask("git count-objects -x");
    allow("git cat-file -p HEAD");
    allow("git cat-file -t HEAD");
    allow("git cat-file -s HEAD");
    ask("git cat-file --batch");
    ask("git cat-file");
    ask("git cat-file -p");
  });

  it("allows read-only git config queries", () => {
    allow("git config --get user.name");
    allow("git config --get-all user.email");
    allow("git config --get-regexp '^alias\\.'");
    allow("git config --list");
    allow("git config user.name");
    allow("git config --global --get user.email");
    allow("git config -l --show-origin");
    ask("git config user.name newvalue");
    ask("git config --global user.name newvalue");
    ask("git config --unset user.name");
    ask("git config --add user.name x");
    ask("git config --file /tmp/cfg --get user.name");
    ask("git config --edit");
  });

  it("allows the --version form", () => {
    allow("git --version");
    ask("git --version extra");
  });

  it("allows composed branch, log, and merge-base inspection lines", () => {
    allow(
      "git branch -a && git log --oneline -5 main && git log --oneline -5 hide_prefilled",
    );
    allow(
      "git merge-base hide_prefilled main && git diff hide_prefilled...main --stat -- src/a src/b | head -40",
    );
    allow(
      "git diff hide_prefilled...main --stat -- src/a/ && git log --oneline hide_prefilled..main --merges | head -5; git diff hide_prefilled...main -- src/a/b.ts | head -500",
    );
  });
});
