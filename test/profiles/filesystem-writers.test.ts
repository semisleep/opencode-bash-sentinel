import path from "node:path";
import { describe, expect, it } from "vitest";
import { allow, ask, decision, root } from "../policy/helpers";

describe("filesystem writer profiles", () => {
  it("consumes option values without reporting them as mutation scopes", () => {
    const cases = [
      ["mkdir -m 755 build", ["build"]],
      ["touch -r template output", ["output"]],
      ["truncate -s 0 output", ["output"]],
      ["shred -n 3 output", ["output"]],
      ["tee output", ["output"]],
    ] as const;

    for (const [source, scopes] of cases) {
      const result = decision(source);
      expect(result.action, source).toBe("allow");
      expect(result.units[0]?.mutationScopes, source).toEqual(
        scopes.map((scope) => path.join(root, scope)),
      );
    }
  });

  it("rejects external writes and unsupported adjacent forms", () => {
    ask("touch /tmp/output");
    ask("touch -r /tmp/template output");
    ask("mkdir --unknown output");
    ask("truncate -s $SIZE output");
    ask("tee $OUTPUT");
    ask("mkdir -p");
    ask("truncate -s 0");
    ask("shred -n 3");
    allow("touch --no-create output");
  });
});
