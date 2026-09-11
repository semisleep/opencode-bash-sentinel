import { describe, expect, it } from "vitest";
import { allow, ask, decision } from "../policy/helpers";

describe("search profiles", () => {
  it("supports finite search forms and explicit read paths", () => {
    allow("rg TODO src");
    allow("grep -n pattern /etc/hosts");
    allow("rg pattern");
    allow("rg --files");
    expect(decision("rg --files /tmp").units[0]?.situation).toBe(
      "workspace-outside",
    );
    ask("rg --pre ./filter TODO src");
    ask("grep --files");
    ask("grep -f /tmp/patterns file");
    ask("rg $PATTERN src");
  });

  it("accepts grep's valueless read-only flags but keeps rg's classes apart", () => {
    allow('grep -rn "pattern" src');
    allow('grep -iE "a|b" file');
    allow("grep -Erqxb pattern file");
    allow("grep -P pattern file");
    allow("rg -a -o pattern src");
    allow("rg --text pattern src");
    ask("rg -E utf8 pattern");
  });

  it("supports numeric context widths in both classes", () => {
    allow("rg -A 5 pattern file");
    allow("rg -A5 pattern file");
    allow("rg -B2 -A12 'FAIL|AssertionError' log.txt");
    allow("grep -A 5 pattern file");
    allow("grep -B3 pattern file");
    allow("rg --after-context=3 pattern file");
    allow("rg --before-context 2 pattern file");
    allow("grep --after-context=3 pattern file");
    ask("rg -A");
    ask("rg -B");
    ask("rg -A five pattern file");
    ask("rg --after-context=wide pattern file");
  });

  it("supports rg's stdout-only replacement forms", () => {
    allow("rg -r n 'permission.asked' node_modules/");
    allow("rg -rn 'permission.asked' node_modules/");
    allow("rg --replace=xx pattern file");
    allow("rg --replace xx pattern file");
    ask("rg -r");
    ask("grep --replace x pattern file");
    ask("grep -Areplacement pattern file");
  });

  it("splits long options per tool", () => {
    allow("grep --extended-regexp pattern file");
    allow("grep --recursive pattern src");
    allow("rg --hidden pattern src");
    ask("grep --hidden pattern file");
    ask("grep --follow pattern file");
    ask("grep --no-heading pattern file");
  });
});
