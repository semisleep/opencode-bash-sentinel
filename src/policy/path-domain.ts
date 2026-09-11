import { isScratchDescendant } from "./scratch";
import { isSensitiveTarget } from "./sensitive";
import type { WorkspaceContext } from "./types";

// ADR-0005: single ownership of the external path-domain rules. The Bash
// situation-2 branch, the edit gate, and the external_directory read-origin
// branch must consult these predicates instead of re-deriving the rule, so
// the same effect semantics yield the same verdict on every gate.

export type PathVerdict =
  | { allow: true; reason?: undefined }
  | { allow: false; reason: string };

export function sensitiveVerdict(
  resolvedPath: string,
  ctx: WorkspaceContext,
): PathVerdict {
  return isSensitiveTarget(resolvedPath, ctx.homedir, ctx.extraSensitiveRoots)
    ? { allow: false, reason: "sensitive external read" }
    : { allow: true };
}

export function scratchMutationVerdict(
  resolvedPath: string,
  ctx: WorkspaceContext,
): PathVerdict {
  return isScratchDescendant(resolvedPath, ctx.scratchRoots ?? [])
    ? { allow: true }
    : {
        allow: false,
        reason: "external write or unsupported external operation",
      };
}
