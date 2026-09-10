import { describe, it } from "vitest";
import { allow } from "../policy/helpers";

describe("Make workflow profile", () => {
  it("supports conventional targets and explicit clean makefiles", () => {
    allow("make test");
    allow("make -f build.mk test");
  });
});
