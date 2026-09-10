import { describe, it } from "vitest";
import { allow, ask } from "../policy/helpers";

describe("filesystem removal profiles", () => {
  it("allows bounded subpath removal and preserves both red lines", () => {
    allow("rm -rf build");
    allow("rmdir empty");
    ask("rm -rf .");
    ask("rm .git/index");
    ask("rm /tmp/file");
  });

  it("rejects parent removal, unknown options and dynamic paths", () => {
    ask("rmdir -p empty/child");
    ask("rmdir --parents empty/child");
    ask("rm --unknown build");
    ask("rm $TARGET");
    ask("rm");
    ask("rmdir");
    ask(String.raw`rm -rf $'\x2e\x2e/project'`);
  });
});
