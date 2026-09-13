import { describe, it } from "vitest";
import { allow, ask } from "../policy/helpers";

describe("sed profile", () => {
  it("supports finite substitution and address-print programs", () => {
    allow("sed 's/a/b/' README.md");
    allow("sed -n -e 's/a/b/p' README.md");
    allow("sed -e 's/a/b/' -e 's/c/d/g' README.md");
    allow("sed -i 's/a/b/g' src/file.ts");
    allow("sed 's/a/b/g' /etc/hosts");
    allow("sed -n '1,60p' README.md");
    allow("sed -n '1,$p' README.md");
    allow("sed '5p' README.md");
    allow("sed -n -e 's/a/b/p' -e '1,60p' README.md");
    allow("sed -n '4835,4860p;5880,5900p' types.gen.d.ts");
    allow("sed -n 'p;$p' README.md");
    ask("sed '1w /tmp/out' README.md");
    ask("sed '/x/w /tmp/out' README.md");
    ask("sed '1e touch /tmp/out' README.md");
    ask("sed 's/a/b/w /tmp/out' README.md");
    ask("sed '1,+5p' README.md");
    ask("sed '1,2,3p' README.md");
    ask("sed -n '1,5p;w /tmp/out' README.md");
    ask("sed -n '1,5p;s/a/b/w /tmp/out' README.md");
    ask("sed '1,2p;3,4d' README.md");
    ask("sed -n '1p;;2p' README.md");
    ask("sed -i '1d' README.md");
    ask("sed -i.bak 's/a/b/' README.md");
    ask("sed --in-place=.bak 's/a/b/' README.md");
  });

  it("supports regex addresses in address-print programs", () => {
    allow("sed -n '/x/p' README.md");
    allow("sed -n '/start/,/end/p' README.md");
    allow("sed -n '85,/bar/p' README.md");
    allow("sed -n '/foo/,$p' README.md");
    allow("sed -n '/a\\/b/p' README.md");
    allow("sed -n '1,/^## 九/p' README.md");
    allow(
      "sed -n '/^## 六、企业标签/,/^## 七、/p' doc/企业微信写回.md | head -20",
    );
    ask("sed '/x/,/y/w /tmp/out' README.md");
    ask("sed -n '/x/e rm -rf /' README.md");
    ask("sed -n '/x/,/y/s/a/b/' README.md");
    ask("sed -n '\\#x#p' README.md");
    ask("sed -n '/x/!p' README.md");
    ask("sed -n '/x/Ip' README.md");
    ask("sed -n '/a;b/p' README.md");
    ask("sed -n '/x/,/y/p;s/a/b/w /tmp/out' README.md");
  });
});
