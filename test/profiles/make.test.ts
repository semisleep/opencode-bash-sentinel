import path from "node:path";
import { describe, expect, it } from "vitest";
import { allow, ask, decision, root } from "../policy/helpers";

describe("Make workflow profile", () => {
  it("supports conventional targets and every explicit makefile", () => {
    allow("make test");
    allow("make -f build.mk test");
    allow("make -f first.mk -f second.mk test");
    ask("make -f first.mk -f second.mk test", { "first.mk": "dirty" });
    ask("make -f first.mk -f second.mk test", { "second.mk": "dirty" });
    ask("make -f first.mk -f second.mk test", { "second.mk": "absent" });
    expect(
      decision("make -f first.mk -f second.mk test").units[0]
        ?.stabilityDependencies,
    ).toEqual([path.join(root, "first.mk"), path.join(root, "second.mk")]);
  });

  it("uses one deterministic default-file fallback", () => {
    allow("make test", { GNUmakefile: "absent", Makefile: "clean" });
    ask("make test", { GNUmakefile: "dirty", Makefile: "clean" });
    ask("make test", { GNUmakefile: "absent", Makefile: "absent" });
    ask("make test", { GNUmakefile: "unknown", Makefile: "clean" });
  });

  it("rejects unsupported, dynamic and external selectors", () => {
    ask("make -f -");
    ask("make --unknown test");
    ask("make -f $MAKEFILE test");
    ask("make -f /tmp/Makefile test");
    ask("cd /tmp && make test");
    ask("make -j nope test");
  });
});
