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

  it("asks for external reads of sensitive paths (situation-2 red line)", () => {
    // Home directory in the test context is /home/dev.
    ask("cat /home/dev/.ssh/id_ed25519");
    ask("cat ~/.ssh/id_rsa");
    ask("head -c 100 ~/.ssh/id_rsa");
    ask("cat ~/.aws/credentials");
    ask("cat ~/.netrc");
    ask("strings ~/.gnupg/secring.gpg");
    ask("cat < ~/.ssh/id_rsa");
    ask("dd if=/home/dev/.aws/credentials");
    ask("cat /etc/shadow");
    ask("cat ~/.ssh/../.ssh/id_rsa"); // normalizes under ~/.ssh
    // Adjacent siblings must NOT match the roots.
    allow("cat ~/.sshfoo");
    allow("cat ~/.aws-notes");
    // A workspace file merely named like a secret stays situation-1 allow.
    allow("cat credentials");
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
