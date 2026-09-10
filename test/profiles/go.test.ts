import { describe, it } from "vitest";
import { allow, ask } from "../policy/helpers";

describe("Go workflow profile", () => {
  it("requires reviewed forms, workspace paths and clean module files", () => {
    allow("go test ./...");
    allow("go mod tidy");
    ask("go test", { "go.mod": "absent" });
    ask("go test ../outside");
    ask("go test /tmp/outside");
    ask("cd /tmp && go test ./...");
  });
});
