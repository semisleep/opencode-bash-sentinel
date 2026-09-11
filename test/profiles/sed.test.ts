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
    ask("sed '/x/p' README.md");
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
});
