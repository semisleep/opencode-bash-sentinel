import { describe, it } from "vitest";
import { allow, ask } from "../policy/helpers";

describe("dd profile", () => {
  it("classifies explicit input and output paths", () => {
    allow("dd if=/etc/hosts");
    allow("dd if=input of=output bs=4096");
    ask("dd if=/etc/hosts of=hosts.copy");
    ask("dd if=input of=/tmp/output");
    ask("dd input output");
    ask("dd if=$INPUT of=output");
  });
});
