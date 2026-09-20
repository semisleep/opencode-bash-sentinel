import { describe, it } from "vitest";
import { allow, ask } from "../policy/helpers";

describe("brew profile", () => {
  it("allows read-only listing and info", () => {
    allow("brew list");
    allow("brew ls");
    allow("brew list --versions");
    allow("brew list -1");
    allow("brew list --formula");
    allow("brew ls jq");
    allow("brew info jq");
    allow("brew abv jq");
    allow("brew --version");
    allow("brew --prefix");
  });

  it("asks for management verbs and unreviewed flags", () => {
    ask("brew install jq");
    ask("brew uninstall jq");
    ask("brew update");
    ask("brew upgrade");
    ask("brew tap");
    ask("brew services list");
    ask("brew info --json=v2 jq");
    ask("brew list --cache");
    ask("brew");
    ask("brew $CMD list");
    ask("brew list jq && rm -rf .git");
  });
});
