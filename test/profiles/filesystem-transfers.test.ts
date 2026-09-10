import path from "node:path";
import { describe, expect, it } from "vitest";
import { allow, ask, decision, root } from "../policy/helpers";

describe("filesystem transfer profiles", () => {
  it("emits the correct mutation scopes for each transfer model", () => {
    expect(decision("cp source destination").units[0]?.mutationScopes).toEqual([
      path.join(root, "destination"),
    ]);
    expect(decision("ln source destination").units[0]?.mutationScopes).toEqual([
      path.join(root, "destination"),
    ]);
    expect(decision("mv source destination").units[0]?.mutationScopes).toEqual([
      path.join(root, "source"),
      path.join(root, "destination"),
    ]);
    allow("cp -R source destination");
    allow("ln -s source destination");
  });

  it("rejects mixed external operations and hidden backup effects", () => {
    ask("cp /tmp/source destination");
    ask("mv source /tmp/destination");
    ask("ln source /tmp/destination");
    ask("mv . /tmp/project");
    ask("cp -b source destination");
    ask("mv -S .bak source destination");
    ask("ln -b source destination");
    ask("cp $SOURCE destination");
    ask("cp --unknown source destination");
  });
});
