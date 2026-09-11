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
    ask("rg -r replacement pattern file");
    ask("rg -A 5 pattern file");
    ask("grep -A 5 pattern file");
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
