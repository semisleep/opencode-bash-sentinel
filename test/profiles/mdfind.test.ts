import { describe, it } from "vitest";
import { allow, ask } from "../policy/helpers";

describe("mdfind profile", () => {
  it("allows read-only Spotlight queries", () => {
    allow("mdfind foo");
    allow('mdfind "kMDItemKind == \'Application\'"');
    allow("mdfind -name Cursor");
    allow("mdfind -h");
  });

  it("asks for streaming, scoped, dynamic, and malformed forms", () => {
    ask("mdfind -live foo");
    ask("mdfind -onlyin /Applications foo");
    ask("mdfind -name");
    ask("mdfind -name -x");
    ask("mdfind -name Cursor extra");
    ask("mdfind foo bar");
    ask("mdfind");
    ask("mdfind $QUERY");
    ask("mdfind foo && rm -rf .git");
  });
});
