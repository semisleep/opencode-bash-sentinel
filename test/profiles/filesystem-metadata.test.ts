import path from "node:path";
import { describe, expect, it } from "vitest";
import { allow, ask, decision, root } from "../policy/helpers";

describe("filesystem metadata profiles", () => {
  it("separates the mode or owner from affected paths", () => {
    expect(decision("chmod 644 file").units[0]?.mutationScopes).toEqual([
      path.join(root, "file"),
    ]);
    expect(decision("chown user:group file").units[0]?.mutationScopes).toEqual([
      path.join(root, "file"),
    ]);
    allow("chmod -R 755 directory");
    allow("chown --recursive user directory");
  });

  it("preserves external and .git write boundaries", () => {
    ask("chmod 644 /tmp/file");
    ask("chown user .git/config");
    ask("chmod --reference=other file");
    ask("chmod $MODE file");
    ask("chown user");
  });
});
