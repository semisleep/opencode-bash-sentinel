import { describe, expect, it } from "vitest";
import { allow, ask, decision } from "../policy/helpers";

describe("plutil profile", () => {
  it("allows read-only query forms with positively identified reads", () => {
    allow("plutil -lint Info.plist");
    allow("plutil -lint a.plist b.plist");
    allow("plutil Info.plist");
    allow("plutil -p Info.plist");
    allow("plutil -type CFBundleIdentifier Info.plist");
    allow("plutil -type CFBundleIdentifier -expect string Info.plist");
    allow("plutil -extract CFBundleIdentifier raw Info.plist");
    allow("plutil -extract a.b json Info.plist");
    allow("plutil -extract a.b raw -n Info.plist");
    allow("plutil -extract a.b xml1 -expect dictionary Info.plist");
    allow("plutil -help");
    allow("plutil -lint /etc/hosts");
    expect(decision("plutil -lint Info.plist").units[0]?.situation).toBe(
      "workspace-inside",
    );
    expect(decision("plutil -lint /etc/hosts").units[0]?.situation).toBe(
      "workspace-outside",
    );
  });

  it("asks for plist-writing forms, dynamic args, and malformed shapes", () => {
    ask("plutil -convert json Info.plist");
    ask("plutil -convert xml1 -o out.plist Info.plist");
    ask("plutil -convert json -o - Info.plist");
    ask("plutil -convert json -e plist Info.plist");
    ask("plutil -convert objc -header Info.plist");
    ask("plutil -insert a.b -string x Info.plist");
    ask("plutil -replace a.b -integer 3 Info.plist");
    ask("plutil -remove a.b Info.plist");
    ask("plutil -create xml1 Info.plist");
    ask("plutil -o out.plist Info.plist");
    ask("plutil");
    ask("plutil -lint");
    ask("plutil -p");
    ask("plutil -lint Info.plist -p");
    ask("plutil -lint Info.plist -s");
    ask("plutil -s Info.plist");
    ask("plutil -lint - f");
    ask("plutil -lint $F");
    ask("plutil -type");
    ask("plutil -type -expect string Info.plist");
    ask("plutil -extract a.b Info.plist");
    ask("plutil -extract a.b weird Info.plist");
    ask("plutil -extract a.b raw Info.plist -n");
    ask("plutil -extract a.b raw -expect weird Info.plist");
    ask("plutil -help Info.plist");
    ask("plutil -lint Info.plist && rm -rf .git");
    ask("plutil -p Info.plist; git push");
    ask("plutil -lint ~/.ssh/id_rsa");
  });
});
