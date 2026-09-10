import path from "node:path";
import { describe, expect, it } from "vitest";
import { allow, ask, decision, root } from "../policy/helpers";

describe("Go workflow profile", () => {
  it("supports reviewed workflows and workspace package selectors", () => {
    allow("go build -v ./cmd/tool");
    allow("go test ./...");
    allow("go vet ./pkg");
    allow("go fmt ./pkg");
    allow("go mod download");
    allow("go mod tidy");
    allow("go test ./...", { "go.sum": "absent" });
    expect(
      decision("go test ./...", { "go.sum": "absent" }).units[0]
        ?.stabilityDependencies,
    ).toEqual([path.join(root, "go.mod")]);
  });

  it("requires clean module baseline dependencies", () => {
    ask("go test", { "go.mod": "dirty" });
    ask("go test", { "go.mod": "absent" });
    ask("go test", { "go.mod": "unknown" });
    ask("go test", { "go.sum": "dirty" });
    ask("go test", { "go.sum": "unknown" });
  });

  it("rejects unsupported, dynamic and external forms", () => {
    ask("go run ./cmd/tool");
    ask("go test --race ./...");
    ask("go $COMMAND ./...");
    ask("go test $PACKAGE");
    ask("go test ../outside");
    ask("go test /tmp/outside");
    ask("cd /tmp && go test ./...");
    ask("go mod tidy extra");
  });
});
