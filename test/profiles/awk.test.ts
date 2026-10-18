import { describe, it } from "vitest";
import { allow, ask } from "../policy/helpers";

describe("awk profile", () => {
  it("allows print-only programs over stdin or file operands", () => {
    allow("awk 'NR % 20 == 1'");
    allow("awk -F'timestamp=|level=' '{print $2}'");
    allow("awk -F: '{print $1}' /etc/passwd");
    allow("awk '/2026-09-29T12:38/' ~/.local/share/opencode/log/opencode.log");
    allow("awk '/x/ && /y/' ~/.local/share/opencode/log/opencode.log");
    allow("awk 'NR>=2314 && /^#+ / {print NR\": \"$0}' notes.txt");
    allow(
      "awk '{ if (length($0) > 500) print NR\": \"length($0) }' notes.txt",
    );
    allow("awk -v field=3 '$field == \"x\"' input.txt");
    allow("grep -E \"Charge:\" lastnight.log | awk 'NR % 20 == 1' | head -40");
    allow("awk --version");
    // Word-boundary screen: `close` inside `disclosed` is not the builtin.
    allow("awk 'BEGIN { print \"disclosed: \" } 1' notes.txt");
  });

  it("keeps process and file I/O out of programs", () => {
    ask("awk 'BEGIN { system(\"id\") }'");
    ask("awk '{print $0 > \"/tmp/awk-out\"}' notes.txt");
    ask("awk '{ print | \"sort\" }' notes.txt");
    ask("awk '{ print |& \"cmd\" }' notes.txt");
    ask("awk '{print getline}' notes.txt");
    ask("awk '{print ENVIRON[\"HOME\"]}' notes.txt");
    ask("awk 'BEGIN { ARGV[1] = \"/etc/passwd\" } 1'");
    ask("awk '{ close(\"file\") }' notes.txt");
    ask("awk '$0 > 5' notes.txt");
    ask("awk -f /tmp/prog.awk notes.txt");
    ask("awk -fprog.awk notes.txt");
    ask("awk -q '{print $1}' notes.txt");
    ask("awk '{print \"a\\tb\"}'");
    ask("awk");
    ask("awk $PROG");
    ask("awk '{system(\"id\")}' --help");
    ask("awk '1' && git push");
  });

  it("routes file operands through the read rules", () => {
    // A comparison `>` outside parentheses refuses even when harmless
    // (BSD/GNU redirect ambiguity); only parenthesized comparisons pass.
    ask("awk '$2 > $3' notes.txt");
    // Sensitive external reads ask exactly like any other reader.
    ask("awk '/x/' ~/.ssh/id_rsa");
    // A bounded glob operand is a read like grep's.
    allow("awk '/error/' src/*.ts");
  });
});
