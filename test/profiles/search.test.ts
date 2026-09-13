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
    allow("rg -F 'a[bc]' src");
    allow("grep -F 'x.y' file");
    allow("rg -Fn pattern src");
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
    ask("rg -C3 pattern file");
    ask("grep -rA5 pattern file");
    // Pre-existing quirk: separated -C 2 swallows 2 as the pattern; the
    // misparse stays read-only -> read-only, so the allow is tolerable.
    allow("rg -A 3 -C 2 pattern file");
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

  it("supports rg's --include-zero display flag without leaking to grep", () => {
    allow("rg -ln pattern src --include-zero");
    allow("rg --include-zero -c pattern src");
    allow("rg --count --include-zero pattern src");
    ask("grep --include-zero pattern file");
    ask("rg --include-zero=x pattern src");
    allow(
      'rg -n "CustomerTagGroup" src/features/admin/server/routes.ts src/features/admin/shared/settings.ts | head -20; rg -ln "CustomerTagGroupSetting\\[\\]|saveCustomerTagGroup|configuredCustomerTagGroups" src --include-zero 2>/dev/null; rg -rln "setConfiguredCustomerTagGroups|saveConfigured" src | head',
    );
  });

  it("allows shell glob path operands behind a literal component", () => {
    allow("rg -n pattern src/*.ts");
    allow("rg -n pattern src/server/[a-c]?.ts");
    allow("grep -rn pattern src/**/*.ts");
    allow("rg pattern -- src/*.ts test/*.md");
    allow("rg --files src/*.ts");
    allow("rg -n pattern ../*.ts");
    allow("rg pattern /etc/*.conf");
    allow("rg pattern ~/*.ts");
    allow("rg -n pattern a*.ts");
    allow("rg -n pattern opencode.json* doc/*.md");
    expect(decision("rg pattern /etc/*.conf").units[0]?.situation).toBe(
      "workspace-outside",
    );
    expect(decision("rg -n pattern src/*.ts").units[0]?.situation).toBe(
      "workspace-inside",
    );
    expect(decision("rg -n pattern opencode.json*").units[0]?.situation).toBe(
      "workspace-inside",
    );
  });

  it("keeps asking for unsafe or dynamic glob forms", () => {
    // A wildcard with no literal prefix in the first component can expand
    // to a leading-dash filename that the tool would reparse as an option.
    ask("rg -n pattern *.ts");
    ask("rg -n pattern -*.ts");
    ask("rg *.ts src");
    // Globs are never safe as the pattern or an option value.
    ask("rg -- *.ts");
    ask("rg -g *.ts pattern src");
    // Expansion, brace, and extglob material stays dynamic.
    ask("rg -n pattern src/$dir/*.ts");
    ask("rg -n pattern {src,test}/*.ts");
    ask("rg -n pattern @(src|test)/*.ts");
    // A dot-prefixed wildcard component can expand to `.` or `..` and so
    // climb out of the prefix bound, and a `..` behind the first wildcard
    // can bypass the sensitive red line; prefix-literal `..` stays fine
    // (pinned as an allow above).
    ask("rg -n pattern .*");
    ask("rg -n pattern ..*");
    ask("rg -n pattern src/.*");
    ask("rg -n pattern src/*/../x/*.ts");
    ask("rg -n pattern src/*/..");
    ask(
      "rg pattern src/*/../../../../home/dev/.ssh/id_rsa",
    );
    // The resolved prefix is still subject to the sensitive red line.
    ask("rg pattern ~/.ssh/*.pub");
  });

  it("recognizes value-taking options after the pattern", () => {
    allow("rg -n pattern src --type ts");
    allow("rg -n pattern src -g '!*test*'");
    allow('rg -n pattern packages -g \'!*sdk*\' -g \'!*generated*\' | head -20');
    allow("rg -rn '\"permission\\.ask\"|permission.ask' src/server src/opencode --type ts -g '!*test*'");
    allow("rg -n 'Plugin.trigger' packages -r --type ts -g '!*sdk*'");
    allow("rg -n pattern src -t ts");
    allow("rg -n pattern src -r rep");
    allow("grep -rn pattern src -E");
    allow("rg pattern -- files");
    // Options past the pattern validate against the same tables, so an
    // unknown flag now asks everywhere instead of lucky-allowing as a
    // misparsed in-workspace read path.
    ask("rg -n pattern src -Z");
    ask("rg -n pattern src --pre x");
    ask("rg -n pattern src -g");
    ask("rg -n pattern src --type");
  });

  it("allows the composed glob-search shape end to end", () => {
    allow(
      'rg -n "processCustomerRelationshipsUpdate" src/domain/customer-management/server/*.ts | head -5; echo ---; rg -ln "status.*valid|\'valid\'" src/domain/customer-management/server/ | head',
    );
  });
});
