import { describe, it } from "vitest";
import { allow, ask } from "../policy/helpers";

describe("information profiles", () => {
  it("covers every registered information command", () => {
    for (const source of [
      "date",
      "uname -a",
      "uptime",
      "whoami",
      "id -Gn",
      "free -h",
      "vm_stat",
      "nproc --all",
      "nproc --ignore 1",
      "lscpu -a -J",
      "ps aux",
      "pwd -P",
      "which",
      "which opencode",
      "which -a python3",
      "true",
      "false",
      ":",
    ])
      allow(source);
  });

  it("rejects options or operands outside each finite form", () => {
    ask("uname --kernel-name");
    ask("date tomorrow");
    ask("uptime extra");
    ask("whoami extra");
    ask("vm_stat extra");
    ask("nproc --ignore");
    ask("nproc --ignore nope");
    ask("lscpu --json");
    ask("pwd --logical");
    ask("which --all");
    ask("which -s python");
    ask("true extra");
    ask(": extra");
    ask("uname $FLAGS");
  });
});
