import { describe, it } from "vitest";
import { allow, ask } from "../policy/helpers";

describe("log profile", () => {
  it("allows read-only show queries", () => {
    allow("log show");
    allow("log show --last 5m");
    allow("log show --style syslog");
    allow("log show --style=compact --last 1h --info --debug");
    allow(
      'log show --start "2026-10-18 03:00:00" --end "2026-10-18 03:30:00" --style compact --predicate \'eventMessage CONTAINS "processWakeReason"\' 2>/dev/null | head -12',
    );
    allow(
      "log show --start \"2026-10-18 03:01:35\" --end \"2026-10-18 03:01:45\" --style compact --predicate 'process == \"bluetoothd\" AND (eventMessage CONTAINS[c] \"wake\" OR eventMessage CONTAINS \"HID_Host\")' | head -30",
    );
  });

  it("keeps mutating verbs and unknown shapes out", () => {
    ask("log collect --output /tmp/x.logarchive");
    ask("log config --mode private_data:on");
    ask("log stream");
    ask("log stats");
    ask("log show --archive /tmp/a.logarchive");
    ask("log show --uuid abc");
    ask("log show --style pretty");
    ask("log show --style");
    ask("log show --start");
    ask("log show --start --end 5m");
    ask("log show --start /etc/passwd");
    ask("log show --predicate 'x' extra-operand");
    ask("log show --predicate 'eventMessage CONTAINS \"x'");
    ask("log show --predicate \"$(whoami)\"");
    ask("log show --last 1m && rm -rf .git");
  });
});
