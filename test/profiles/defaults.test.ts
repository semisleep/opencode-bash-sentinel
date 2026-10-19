import { describe, expect, it } from "vitest";
import { allow, ask, decision } from "../policy/helpers";

describe("defaults profile", () => {
  it("allows read-only queries", () => {
    allow("defaults read com.apple.finder");
    allow("defaults read com.apple.finder AppleShowAllExtensions");
    allow("defaults read -g AppleShowAllExtensions");
    allow("defaults read-type com.apple.finder AppleShowAllExtensions");
    allow("defaults domains");
    allow(
      "defaults read /Applications/ChatGPT.app/Contents/Info.plist CFBundleIdentifier",
    );
  });

  it("classifies plist operands like ordinary reads", () => {
    expect(
      decision("defaults read /Applications/ChatGPT.app/Contents/Info.plist")
        .units[0]?.situation,
    ).toBe("workspace-outside");
    expect(decision("defaults read com.apple.finder").units[0]?.situation).toBe(
      "workspace-neutral-or-indeterminate",
    );
  });

  it("allows -currentHost scoped reads", () => {
    allow("defaults -currentHost read com.apple.screensaver");
    allow("defaults -currentHost read com.apple.screensaver idleTime");
    allow("defaults -currentHost read-type com.apple.screensaver idleTime");
    allow("defaults -currentHost domains");
    allow(
      "defaults -currentHost read /Applications/ChatGPT.app/Contents/Info.plist CFBundleIdentifier",
    );
  });

  it("keeps -currentHost mutations and other scope flags out", () => {
    ask("defaults -currentHost write com.apple.screensaver idleTime 60");
    ask("defaults -currentHost delete com.apple.screensaver idleTime");
    ask("defaults -currentHost rename com.apple.screensaver old new");
    ask("defaults -currentHost import com.apple.screensaver file.plist");
    ask("defaults -currentHost");
    ask("defaults -currentHost read");
    ask("defaults -currentHost -currentHost read com.apple.screensaver");
    ask("defaults -host macmini read com.apple.screensaver");
    ask("defaults -currentHost read a b c");
    ask("defaults -currentHost read $DOMAIN");
    ask("defaults -currentHost read com.apple.screensaver && rm -rf .git");
  });

  it("asks for mutating verbs and malformed shapes", () => {
    ask("defaults write com.apple.finder Foo -bool true");
    ask("defaults delete com.apple.finder Foo");
    ask("defaults rename com.apple.finder Old New");
    ask("defaults import com.apple.finder file.plist");
    ask("defaults export com.apple.finder file.plist");
    ask("defaults read");
    ask("defaults read -x foo");
    ask("defaults read com.apple.finder -x");
    ask("defaults read a b c");
    ask("defaults domains extra");
    ask("defaults read $DOMAIN");
    ask("defaults read com.apple.finder Foo && rm -rf .git");
    ask("defaults read ~/.ssh/config");
  });
});
