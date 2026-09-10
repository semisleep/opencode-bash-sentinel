import { describe, it } from "vitest";
import { allow, ask } from "./helpers";

describe("workspace situations and red lines", () => {
  it("allows workspace effects except root removal and direct .git mutation", () => {
    allow("rm -rf build");
    allow("echo x > out");
    allow("chmod 000 .");
    ask("rm -rf .");
    ask("mv . /tmp/project");
    ask("echo x > .git/config");
    ask("rm .git/index");
  });

  it("allows finite external reads and asks for external writes", () => {
    allow("cat /etc/hosts");
    allow("ls -la /tmp");
    allow("rg TODO /usr/include");
    ask("rm /tmp/x");
    ask("echo x > /tmp/x");
    ask("cp /tmp/x ./x");
    ask("mv /tmp/x ./x");
  });

  it("does not infer paths from unsupported command shapes", () => {
    ask("unknown /work/project/file");
    ask("rm $TARGET");
    ask("cat *.txt");
    ask("cat --unknown README.md");
    ask("rm --unknown build");
    ask("rg --pre ./filter TODO src");
    ask("cp -t .git source");
  });
});
