import { describe, it } from "vitest";
import { allow, ask } from "../policy/helpers";

describe("find profile", () => {
  it("allows read-only traversals with reviewed primaries", () => {
    allow('find src test -type f -name "*.ts"');
    allow("find . -maxdepth 2 -name '*.log'");
    allow('find -H src -type f -print0');
    allow("find");
    allow("find src -newer reference");
    allow("find src '(' -type f -o -type l ')'");
    allow('find src -printf "%p\\n"');
    allow("find /etc -name hosts");
  });

  it("asks for destructive, writing, or unknown primaries", () => {
    ask('find src -name "*.ts" -delete');
    ask('find src -exec rm {} +');
    ask("find src -fprint /tmp/out");
    ask('find src -fprintf /tmp/f "%p"');
    ask("find src -fls /tmp/ls");
    ask("find src -newermt 2024-01-01");
    ask("find src -O3 -type f");
    ask("find src -unknown x");
    ask("find $DIR -name x");
    ask("find src -name");
    ask("find src -type f extra-path");
    ask("find src -L");
  });

  it("classifies traversal roots and references as reads", () => {
    allow("cat < /dev/null");
    ask("find ~/.ssh -name 'id_*'");
    ask("find src -newer ~/.ssh/known_hosts");
    allow("find src | sort");
  });
});
