import path from "node:path";
import { describe, expect, it } from "vitest";
import { allow, ask, decision, root } from "../policy/helpers";

describe("Cargo workflow profile", () => {
  it("supports the reviewed subcommands and optional lock file", () => {
    allow("cargo build");
    allow("cargo test filter");
    allow("cargo check");
    allow("cargo fmt -v");
    allow("cargo clippy -x");
    allow("cargo check", { "Cargo.lock": "absent" });
    expect(
      decision("cargo check", { "Cargo.lock": "absent" }).units[0]
        ?.stabilityDependencies,
    ).toEqual([path.join(root, "Cargo.toml")]);
  });

  it("requires clean baseline dependencies", () => {
    ask("cargo check", { "Cargo.toml": "dirty" });
    ask("cargo check", { "Cargo.toml": "absent" });
    ask("cargo check", { "Cargo.toml": "unknown" });
    ask("cargo check", { "Cargo.lock": "dirty" });
    ask("cargo check", { "Cargo.lock": "unknown" });
  });

  it("rejects unsupported, dynamic and external forms", () => {
    ask("cargo run");
    ask("cargo build --release");
    ask("cargo build unexpected");
    ask("cargo test one two");
    ask("cargo $COMMAND");
    ask("cargo test $FILTER");
    ask("cd /tmp && cargo check");
  });
});
