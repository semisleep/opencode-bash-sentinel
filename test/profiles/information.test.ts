import { describe, it } from "vitest";
import { allow, ask } from "../policy/helpers";

describe("information profiles", () => {
  it("allows only reviewed forms", () => {
    allow("date");
    allow("uname -a");
    allow("ps aux");
    ask("uname --kernel-name");
  });
});
