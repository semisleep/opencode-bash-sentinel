import { describe, it } from "vitest";
import { allow, ask } from "../policy/helpers";

describe("pip profile", () => {
  it("supports bounded information forms", () => {
    allow("pip list");
    allow("pip show requests wheel");
    allow("pip check");
    allow("pip freeze");
    allow("pip3 list");
    allow("python -m pip check");
    ask("pip show");
    ask("pip list extra");
    ask("pip check --verbose");
    ask("pip $COMMAND");
  });

  it("requires a clean internal requirements file", () => {
    allow("pip install -r requirements.txt");
    allow("python -m pip install -r requirements.txt");
    ask("pip install -r requirements.txt", { "requirements.txt": "dirty" });
    ask("pip install -r requirements.txt", { "requirements.txt": "absent" });
    ask("pip install -r requirements.txt", { "requirements.txt": "unknown" });
    ask("pip install -r /tmp/requirements.txt");
    ask("pip install -r $REQUIREMENTS");
    ask("pip install requests");
  });

  it("uses only present clean local project control files", () => {
    allow("cd packages/app && pip install .", {
      "packages/app/pyproject.toml": "clean",
      "packages/app/setup.cfg": "absent",
      "packages/app/setup.py": "absent",
    });
    ask("pip install .", {
      "pyproject.toml": "dirty",
      "setup.cfg": "absent",
      "setup.py": "absent",
    });
    ask("pip install .", {
      "pyproject.toml": "absent",
      "setup.cfg": "absent",
      "setup.py": "absent",
    });
    ask("pip install .", {
      "pyproject.toml": "unknown",
      "setup.cfg": "absent",
      "setup.py": "absent",
    });
    ask("cd /tmp && pip install .");
  });
});
