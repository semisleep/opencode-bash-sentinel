import { describe, it } from "vitest";
import { allow, ask } from "../policy/helpers";

describe("sed profile", () => {
  it("supports only finite substitution programs", () => {
    allow("sed 's/a/b/' README.md");
    allow("sed -n -e 's/a/b/p' README.md");
    allow("sed -e 's/a/b/' -e 's/c/d/g' README.md");
    allow("sed -i 's/a/b/g' src/file.ts");
    allow("sed 's/a/b/g' /etc/hosts");
    ask("sed '1w /tmp/out' README.md");
    ask("sed '/x/w /tmp/out' README.md");
    ask("sed '1e touch /tmp/out' README.md");
    ask("sed 's/a/b/w /tmp/out' README.md");
    ask("sed -i '1d' README.md");
    ask("sed -i.bak 's/a/b/' README.md");
    ask("sed --in-place=.bak 's/a/b/' README.md");
  });
});
