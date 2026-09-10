import { describe, it } from "vitest";
import { allow, ask } from "../policy/helpers";

describe("pip profile", () => {
  it("supports bounded information and clean local installation forms", () => {
    allow("pip install -r requirements.txt");
    allow("python -m pip check");
    ask("pip install requests");
    allow("cd packages/app && pip install .", {
      "packages/app/pyproject.toml": "clean",
      "packages/app/setup.cfg": "absent",
      "packages/app/setup.py": "absent",
    });
    ask("cd /tmp && pip install .");
  });
});
