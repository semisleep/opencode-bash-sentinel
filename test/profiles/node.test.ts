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

  it("screens arguments forwarded after `--` like direct script arguments", () => {
    allow("npm test -- src/");
    allow("npm test -- --reporter=dot");
    allow("npm run build -- --output=dist/");
    ask("npm test -- --require=/tmp/pwn.js");
    ask("npm test -- /etc/passwd");
    ask("npm run build -- --external=/tmp/x");
    ask("npm test -- ~");
    ask("npm test -- env=~/secret");
  });

  it("participates in generic stability conflicts", () => {
    ask("printf x > package.json && npm run build");
    allow("printf x > other.json && npm run build");
  });

  it("allows read-only dependency listing without the workflow baseline", () => {
    allow("npm ls");
    allow("npm ls -g");
    allow("npm list --global");
    allow("npm ls -g --depth=0");
    allow("npm ls typescript @types/node");
    allow("npm ls --json");
    allow("pnpm ls");
    allow("yarn list");
    allow("npm ls", { "package.json": "dirty" });
    ask("npm ls --depth=abc");
    ask("npm ls --long");
    ask("npm ls -g --prefix /tmp/x");
    ask("npm install");
    ask("npm ls typescript && rm -rf .git");
    ask("npm ls $PKG");
  });

  it("allows read-only audit reports without the workflow baseline", () => {
    allow("npm audit");
    allow("npm audit --json");
    allow("npm audit signatures");
    allow("npm audit signatures --json");
    allow("npm audit --audit-level=high --omit=dev --package-lock-only");
    allow("pnpm audit --json");
    allow("yarn audit");
    allow("yarn npm audit --json");
    allow("bun audit");
    allow("npm audit", { "package.json": "dirty" });
  });

  it("asks for audit fix, unmodeled flags, and dynamic audit forms", () => {
    ask("npm audit fix");
    ask("npm audit fix --dry-run");
    ask("npm audit --dry-run");
    ask("npm audit -f");
    ask("npm audit --force");
    ask("npm audit fix signatures");
    ask("pnpm audit fix");
    ask("yarn audit fix");
    ask("yarn npm audit fix");
    // Separate value forms stay out so a value can never swallow an operand.
    ask("npm audit --audit-level high");
    ask("npm audit --omit dev");
    ask("npm audit --omit");
    // Unmodeled report options.
    ask("npm audit --registry=https://example.test");
    ask("npm audit -w app");
    ask("npm audit $FLAGS");
    ask("npm audit && rm -rf .git");
  });
});
