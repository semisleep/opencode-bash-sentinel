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
      "ps auxww",
      "pwd -P",
      "pwd --physical",
      "date --utc +%F",
      "date --universal",
      "date --iso-8601",
      "date --iso-8601=minutes",
      "uname --all",
      "uname --kernel-release",
      "id --user",
      "id --groups",
      "uptime -p",
      "uptime --pretty",
      "which",
      "which opencode",
      "which -a python3",
      "true",
      "false",
      ":",
      "sleep 2",
      "sleep 0.5",
      "sleep 2 && echo ok",
    ])
      allow(source);
  });

  it("supports ps output-format and pid selectors", () => {
    allow("ps -o pid,ppid,lstart,etime,command -p 96906");
    allow("ps -p 1");
    allow("ps -p1");
    allow("ps -o command");
    allow("ps -ef");
    allow("ps -ax");
    allow("ps -o %cpu,%mem -p 1,2");
    // Missing values, non-column/non-numeric values, and bare operands
    // stay unrecognized; -o only formats output, -p only selects pids.
    ask("ps -o");
    ask("ps -o /etc/x");
    ask("ps -p abc");
    ask("ps extra-operand");
    ask("ps -o command -p 1; git push");
  });

  it("rejects options or operands outside each finite form", () => {
    ask("uname --unknown-flag");
    ask("uname --kernel-name extra");
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
    ask("uptime -x");
    ask("whoami extra");
    ask("vm_stat extra");
    ask("nproc --ignore");
    ask("nproc --ignore nope");
    ask("lscpu --json");
    ask("pwd --physicals");
    ask("which --all");
    ask("which -s python");
    ask("true extra");
    ask(": extra");
    ask("uname $FLAGS");
    ask("sleep");
    ask("sleep foo");
    ask("sleep 2m");
    ask("sleep 1 2");
  });
});
