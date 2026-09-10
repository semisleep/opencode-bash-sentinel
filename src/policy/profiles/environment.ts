import type { SyntaxNode } from "../../parser/node";
import { environmentName } from "../normalize";
import type { UnitSeed } from "../types";

const RISKY_ENVIRONMENT_NAMES = new Set([
  "PATH",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "BASH_ENV",
  "ENV",
  "ZDOTDIR",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "HOME",
  "CDPATH",
  "NODE_OPTIONS",
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "RUBYOPT",
  "RUBYLIB",
  "PERL5OPT",
]);

export function isRiskyEnvironmentName(name: string) {
  return RISKY_ENVIRONMENT_NAMES.has(name) || name.startsWith("DYLD_");
}

export function recognizeAssignment(node: SyntaxNode): UnitSeed {
  const name = environmentName(node);
  const allowed = !!name && !isRiskyEnvironmentName(name);
  return {
    kind: "assignment",
    text: node.text,
    situation: "workspace-neutral-or-indeterminate",
    allowed,
    reason: allowed ? "ordinary assignment" : "high-risk assignment",
  };
}

export function recognizeDeclaration(node: SyntaxNode): UnitSeed {
  const keyword = node.children.find((child) => !child.isNamed)?.text;
  const assignments = node.children.filter(
    (child) => child.type === "variable_assignment",
  );
  const allowed =
    !!keyword &&
    ["export", "declare", "typeset", "readonly"].includes(keyword) &&
    assignments.length > 0 &&
    node.namedChildren.length === assignments.length &&
    assignments.every((assignment) => {
      const name = environmentName(assignment);
      return !!name && !isRiskyEnvironmentName(name);
    });
  return {
    kind: "assignment",
    text: node.text,
    situation: "workspace-neutral-or-indeterminate",
    allowed,
    reason: allowed
      ? "recognized declaration"
      : "unsupported or high-risk declaration",
  };
}
