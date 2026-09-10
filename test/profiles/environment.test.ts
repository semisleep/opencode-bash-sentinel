import { describe, it } from "vitest";
import { allow, ask } from "../policy/helpers";

describe("environment assignment profile", () => {
  it("allows ordinary assignments and rejects the short high-risk set", () => {
    allow("CI=1 npm test");
    allow("NODE_ENV=test echo ok");
    allow("export FOO=bar");
    allow("A=1");
    ask("export FOO=bar OTHER");
    ask("declare FOO=bar -x");
    ask("PATH=/tmp echo ok");
    ask("DYLD_INSERT_LIBRARIES=x echo ok");
    ask("export HOME=/tmp");
  });
});
