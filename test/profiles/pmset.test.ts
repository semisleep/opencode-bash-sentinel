import { describe, it } from "vitest";
import { allow, ask } from "../policy/helpers";

describe("pmset profile", () => {
  it("allows one-shot -g queries", () => {
    allow("pmset -g");
    allow("pmset -g live");
    allow("pmset -g custom");
    allow("pmset -g cap");
    allow("pmset -g sched");
    allow("pmset -g ups");
    allow("pmset -g ps");
    allow("pmset -g batt");
    allow("pmset -g therm");
    allow("pmset -g assertions");
    allow("pmset -g sysload");
    allow("pmset -g ac");
    allow("pmset -g adapter");
    allow("pmset -g log");
    allow("pmset -g uuid");
    allow("pmset -g history");
    allow("pmset -g stats");
    allow("pmset -g systemstate");
    allow("pmset -g sleepwakestats");
  });

  it("allows the observed piped log-inspection shapes", () => {
    allow("pmset -g log | grep 'Entering Sleep' | tail -3");
    allow("pmset -g log | grep -E '^2026-10-18 2[0-3]|^2026-10-19 0' | head -150");
    allow(
      "pmset -g log | grep -E '^2026-10-18 1[89]|^2026-10-18 2|^2026-10-19 ' | grep -vE 'Assertion|Charge:' | head -80",
    );
  });

  it("keeps every power-state mutation out", () => {
    ask("pmset");
    ask("pmset -a displaysleep 10");
    ask("pmset -b sleep 0");
    ask("pmset -c disksleep 10");
    ask("pmset -u haltlevel 40");
    ask("pmset displaysleep 5");
    ask("pmset sleepnow");
    ask("pmset displaysleepnow");
    ask("pmset touch");
    ask("pmset boot");
    ask("pmset noidle");
    ask("pmset restoredefaults");
    ask("pmset resetdisplayambientparams");
    ask('pmset schedule wake "07/04/26 20:00:00"');
    ask("pmset schedule cancel");
    ask("pmset repeat shutdown TWRFS 11:00:00");
    ask("pmset repeat cancel");
    ask("pmset relative wake 600");
  });

  it("keeps streaming, variable-arity, and unknown domains out", () => {
    ask("pmset -g pslog");
    ask("pmset -g rawlog");
    ask("pmset -g thermlog");
    ask("pmset -g assertionslog");
    ask("pmset -g sysloadlog");
    ask("pmset -g uuidlog");
    ask("pmset -g powerstatelog");
    ask("pmset -g powerstate");
    ask("pmset -g powerstate AppleSmartBattery");
    ask("pmset -g historydetailed");
    ask("pmset -g historydetailed 1234ABCD");
    ask("pmset -g everything");
    ask("pmset -g log extra");
    ask("pmset -g bogus");
    ask("pmset -g -x");
    ask("pmset -x -g");
    ask("pmset -g $DOMAIN");
  });

  it("keeps red-line compositions asking", () => {
    ask("pmset -g log && rm -rf .git");
    ask("pmset -g; git push");
  });
});
