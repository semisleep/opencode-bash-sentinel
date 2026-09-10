import { describe, it } from "vitest";
import { allow, ask } from "../policy/helpers";

describe("Make workflow profile", () => {
  it("supports conventional targets and explicit clean makefiles", () => {
    allow("make test");
    allow("make -f build.mk test");
    allow("make -f first.mk -f second.mk test");
    ask("make -f first.mk -f second.mk test", { "first.mk": "dirty" });
    ask("make -f -");
    ask("make --unknown test");
  });
});
