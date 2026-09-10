import { describe, it } from "vitest";
import { allow, ask } from "../policy/helpers";

describe("curl profile", () => {
  it("allows bounded stdout HTTP(S) reads only", () => {
    allow("curl -fsSL https://example.com/data");
    allow("curl --head --max-time 2 https://example.com");
    ask("curl -X POST https://example.com");
    ask("curl -o out https://example.com");
    ask('curl "$URL"');
    ask("curl https://user:secret@example.com/path");
    ask("curl 'https://example.com/{one,two}'");
    ask("curl 'https://example.com/[1-2]'");
  });
});
