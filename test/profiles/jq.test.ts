import { describe, expect, it } from "vitest";
import { allow, ask, decision } from "../policy/helpers";

describe("jq profile", () => {
  it("allows pure query forms with positively identified reads", () => {
    allow("jq --version");
    allow("jq . package.json");
    allow("jq -r '.name' package.json");
    allow("jq -c '.dependencies // {}' package.json");
    allow("jq -s . a.json b.json");
    allow("jq --raw-output '.version' package.json");
    allow("jq --arg name x '.name' package.json");
    allow("jq --argjson limit 1 '.limit' data.json");
    allow("jq --slurpfile deps deps.json '.deps' package.json");
    allow("jq --rawfile license LICENSE '.license'");
    allow("jq -f filter.jq input.json");
    allow("jq --indent 2 . package.json");
    allow("jq --indent=4 . package.json");
    allow("jq -- '.' package.json");
    allow("cat data.json | jq .");
    allow("jq . /etc/hosts");
    expect(decision("jq . src/config.json").units[0]?.situation).toBe(
      "workspace-inside",
    );
    expect(decision("jq . /etc/hosts").units[0]?.situation).toBe(
      "workspace-outside",
    );
  });

  it("asks for unsupported, dynamic, or sensitive jq forms", () => {
    ask("jq");
    ask("jq -n");
    ask("jq --indent");
    ask("jq --indent wide . package.json");
    ask("jq --stdin");
    ask("jq --args . a b");
    ask("jq -cn . package.json");
    ask("jq -f");
    ask("jq --arg name");
    ask("jq $FILTER package.json");
    ask("jq . ~/.ssh/known_hosts");
    ask("jq . src/*.json");
  });
});
