import { describe, it } from "vitest";
import { allow, ask } from "../policy/helpers";

describe("launchctl profile", () => {
  it("allows the job-table listing", () => {
    allow("launchctl list");
    allow("launchctl list | grep -i zcode");
    allow("launchctl list 2>/dev/null | grep -i zcode");
    allow("launchctl list com.microsoft.autoupdate.helper");
  });

  it("keeps every mutating or signalling verb out", () => {
    ask("launchctl");
    ask("launchctl load ~/Library/LaunchAgents/x.plist");
    ask("launchctl unload ~/Library/LaunchAgents/x.plist");
    ask("launchctl bootstrap gui/501 /tmp/x.plist");
    ask("launchctl bootout gui/501/com.x");
    ask("launchctl enable system/com.x");
    ask("launchctl disable system/com.x");
    ask("launchctl start system/com.x");
    ask("launchctl stop system/com.x");
    ask("launchctl kickstart -k system/com.x");
    ask("launchctl kill TERM system/com.x");
    ask("launchctl submit -l label -- /usr/bin/sleep 60");
    ask("launchctl list -x");
    ask("launchctl list a b");
    ask("launchctl list $LABEL");
    ask("launchctl list && rm -rf .git");
  });
});
