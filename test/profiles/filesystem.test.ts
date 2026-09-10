import { describe, it } from "vitest";
import { allow, ask } from "../policy/helpers";

describe("filesystem profiles", () => {
  it("rejects parent-removal and unmodeled backup effects", () => {
    ask("rmdir -p empty/child");
    ask("rmdir --parents empty/child");
    ask("cp -b source destination");
    ask("mv -S .bak source destination");
    ask("ln -b source destination");
  });

  it("rejects ANSI-C quoted paths instead of analyzing source spelling", () => {
    ask(String.raw`echo x > $'\x2egit/config'`);
    ask(String.raw`rm -rf $'\x2e\x2e/project'`);
    ask(String.raw`cat $'\x2fetc/passwd'`);
  });
});
