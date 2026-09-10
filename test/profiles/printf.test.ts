import { describe, it } from "vitest";
import { allow, ask } from "../policy/helpers";

describe("printf profile", () => {
  it("allows stdout forms and rejects shell-state mutations", () => {
    allow("printf '%s' value");
    ask("printf -v PATH /tmp");
    ask("printf '%n' PATH");
    ask("printf $'\\x25n' PATH");
    ask("printf $'\\x2dv' PATH /tmp");
    ask("OPTION=-v; printf $OPTION PATH /tmp; git status");
    ask('printf "$FORMAT" value');
  });
});
