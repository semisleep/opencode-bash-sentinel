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

  it("allows shell glob path operands behind a literal component", () => {
    allow("rg -n pattern src/*.ts");
    allow("rg -n pattern src/server/[a-c]?.ts");
    allow("grep -rn pattern src/**/*.ts");
    allow("rg pattern -- src/*.ts test/*.md");
    allow("rg --files src/*.ts");
    allow("rg -n pattern ../*.ts");
    allow("rg pattern /etc/*.conf");
    allow("rg pattern ~/*.ts");
    expect(decision("rg pattern /etc/*.conf").units[0]?.situation).toBe(
      "workspace-outside",
    );
    expect(decision("rg -n pattern src/*.ts").units[0]?.situation).toBe(
      "workspace-inside",
    );
  });

  it("keeps asking for unsafe or dynamic glob forms", () => {
    // A wildcard in the first component can expand to a leading-dash
    // filename that the tool would reparse as an option.
    ask("rg -n pattern *.ts");
    ask("rg -n pattern a*.ts");
    ask("rg -n pattern -*.ts");
    ask("rg *.ts src");
    // Globs are never safe as the pattern or an option value.
    ask("rg -- *.ts");
    ask("rg -g *.ts pattern src");
    // Expansion, brace, and extglob material stays dynamic.
    ask("rg -n pattern src/$dir/*.ts");
    ask("rg -n pattern {src,test}/*.ts");
    ask("rg -n pattern @(src|test)/*.ts");
    // The resolved prefix is still subject to the sensitive red line.
    ask("rg pattern ~/.ssh/*.pub");
  });

  it("allows the composed glob-search shape end to end", () => {
    allow(
      'rg -n "processCustomerRelationshipsUpdate" src/domain/customer-management/server/*.ts | head -5; echo ---; rg -ln "status.*valid|\'valid\'" src/domain/customer-management/server/ | head',
    );
  });
});
