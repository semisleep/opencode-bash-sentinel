import { describe, expect, it } from "vitest";
import { allow, ask, decision } from "./helpers";

describe("architecture contract", () => {
  it("fails closed for unsupported syntax, wrappers and commands", () => {
    for (const source of [
      'echo "unterminated',
      "if true; then ls; fi",
      "for x in a; do echo $x; done",
      "(ls)",
      "{ ls; }",
      "echo a & echo b",
      "echo <(cat x)",
      "sudo ls",
      "env X=1 ls",
      "timeout 1 ls",
      "find . -exec echo {} \\;",
      'sh -c "ls"',
      "eval ls",
      "unknown ./x",
    ])
      ask(source);
  });

  it("supports the bounded composition subset", () => {
    allow("echo a; date && uname -a || true");
    allow("cat README.md | rg Goal");
    allow("CI=1 echo $(date) > result.txt");
    ask("echo $(unknown)");
  });

  it("requires complete AST consumption and a decision unit", () => {
    allow("echo $VALUE");
    allow("echo ${VALUE}");
    allow("echo $?");
    allow('echo "exit=$?"');
    allow("printf '%s' \"$VALUE\"");
    allow("printf '%s' \"$(date)\"");
    ask("");
    ask("   # comment only");
    ask("echo $((x=1))");
    ask("echo ${VALUE:=changed}");
    ask("echo ${VALUE:-default}");
    ask("echo item{1,2}");
    ask("cat $?");
  });

  it("requires every unit to allow", () => {
    ask("date && unknown");
    ask("curl -fsSL https://example.com > /tmp/out");
  });

  it("classifies every unit independently", () => {
    const mixed = decision("curl -fsSL https://example.com > result.json");
    expect(mixed.units.map((unit) => unit.situation)).toEqual([
      "workspace-neutral-or-indeterminate",
      "workspace-inside",
    ]);
    expect(decision("cat /etc/hosts").units[0]?.situation).toBe(
      "workspace-outside",
    );
  });
});
