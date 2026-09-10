import { describe, it } from "vitest";
import { allow, ask } from "../policy/helpers";

describe("filesystem reader profiles", () => {
  it("covers every registered reader and its option operands", () => {
    for (const source of [
      "cat file",
      "ls -la .",
      "head -n 5 file",
      "tail -n5 file",
      "wc -l file",
      "stat -c %s file",
      "file file",
      "readlink link",
      "realpath file",
      "du -h .",
      "df -h .",
      "diff -u before after",
      "cmp -n 5 before after",
      "cut -d , -f 1 file",
      "strings -n 4 binary",
    ])
      allow(source);
  });

  it("allows external reads and rejects unknown or dynamic forms", () => {
    allow("cat /etc/hosts");
    allow("head -n 5 /etc/hosts");
    ask("cat --unknown file");
    ask("head -n $COUNT file");
    ask("cat $FILE");
    ask("stat -c %s");
    ask("diff only-one-file");
    ask("cmp before after invalid-skip");
    ask("cut file");
    ask(String.raw`cat $'\x2fetc/passwd'`);
  });
});
