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
      "sort -u file",
      "sort -k 2 -t , file",
      "tail -5 file",
      "head -3 file",
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

  it("supports numeric line-count shorthand for head and tail", () => {
    allow("tail -8");
    allow("cat x | head -5");
    allow("tail -n 8 file");
    ask("tail -8x");
    ask("tail -n");
  });

  it("allows bounded glob operands on value-free readers", () => {
    allow("ls opencode.json*");
    allow("ls src/*.ts");
    allow("cat CHANGELOG*");
    allow("wc -l package*.json");
    ask("ls *.ts");
    ask("cat *.md");
    ask("ls .*");
    ask("ls src/.*");
    // Value-taking grammars keep literal-only arguments, because a cover
    // eaten as an option value would under-report reads.
    ask("head -n 5 *.ts");
    ask("sort *.ts");
  });

  it("keeps sort read-only", () => {
    allow("sort");
    allow("sort -n -r file");
    allow("sort --check file");
    ask("sort -o out file");
    ask("sort --output=out file");
    ask("sort -T /tmp file");
    ask("sort --compress-program=gzip file");
    ask("sort -Z file");
  });
});
