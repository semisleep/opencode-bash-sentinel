import { describe, it } from "vitest";
import { allow, ask } from "../policy/helpers";

describe("Cargo workflow profile", () => {
  it("requires reviewed forms and clean control files", () => {
    allow("cargo check");
    ask("cargo check", { "Cargo.toml": "dirty" });
    ask("cd /tmp && cargo check");
  });
});
