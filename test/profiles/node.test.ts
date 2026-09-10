import path from "node:path";
import { describe, it } from "vitest";
import { allow, ask, root } from "../policy/helpers";

describe("Node workflow profile", () => {
  it("requires a recognized form and clean effective package.json", () => {
    allow("npm run build");
    allow("npm test");
    ask("npm install");
    ask("npm run build", { "package.json": "dirty" });
    const sub = path.join(root, "packages/app");
    allow(
      "npm run build",
      { "package.json": "dirty", "packages/app/package.json": "clean" },
      sub,
    );
    ask(
      "npm run build",
      { "package.json": "clean", "packages/app/package.json": "dirty" },
      sub,
    );
    allow("cd packages/app && npm run build", {
      "package.json": "dirty",
      "packages/app/package.json": "clean",
    });
    ask("cd /tmp && npm run build");
  });

  it("rejects unreviewed selectors and argument shapes", () => {
    allow("npm run build -- --watch");
    allow("npm test -- --runInBand");
    ask("npm run build --watch");
    ask("npm run --workspace /tmp/pkg test");
    ask("npm test --workspace /tmp/pkg");
    ask("pnpm run --dir /tmp/pkg test");
    ask("yarn run --cwd /tmp/pkg test");
  });

  it("participates in generic stability conflicts", () => {
    ask("printf x > package.json && npm run build");
    allow("printf x > other.json && npm run build");
  });
});
