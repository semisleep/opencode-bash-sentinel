import { describe, it } from "vitest";
import { allow, ask } from "../policy/helpers";

describe("information profiles", () => {
  it("covers every registered information command", () => {
    for (const source of [
      "date",
      "date -u",
      "date -R",
      "date -Iseconds",
      "date +%s",
      "date -u +%Y-%m-%dT%H:%M:%S.000Z",
      "date -R -u +'%H:%M'",
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
    ask("date -s 2026-01-01");
    ask("date --set=2026-01-01");
    ask("date -a 30");
    ask("date -f fmt.txt");
    ask("date -r /etc/hosts");
    ask("date -d yesterday");
    ask("date -u tomorrow");
    ask("date +%s -u");
    ask("date '+%Y %m'");
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
