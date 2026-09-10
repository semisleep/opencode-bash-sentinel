import { describe, it } from "vitest";
import { allow, ask } from "../policy/helpers";

describe("uniq profile", () => {
  it("models distinct input and output operand roles", () => {
    allow("uniq input.txt");
    allow("uniq input.txt output.txt");
    allow("uniq -f 2 input.txt output.txt");
    ask("uniq input.txt /tmp/output.txt");
    ask("uniq one two three");
    ask("uniq --unknown input.txt");
  });
});
