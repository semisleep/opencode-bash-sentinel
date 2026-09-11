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
    ask("rg -E utf8 pattern");
    ask("rg -r replacement pattern file");
    ask("grep -A 5 pattern file");
  });
});
