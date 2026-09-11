import { normalizeBash, invocation } from "./normalize";
import {
  hasGitSegment,
  pathsOverlap,
  resolvePath,
  samePath,
  withinWorkspace,
} from "./paths";
import {
  recognizeAssignment,
  recognizeDeclaration,
} from "./profiles/environment";
import { recognizeCommand } from "./profiles/registry";
import { recognizeRedirect } from "./redirect";
import { isSensitiveTarget } from "./sensitive";
import { isScratchDescendant, isScratchRoot } from "./scratch";
import type {
  DecisionUnit,
  Effect,
  PolicyResult,
  Situation,
  UnitSeed,
  WorkspaceContext,
} from "./types";

export function analyzeWorkspacePolicy(
  source: string,
  ctx: WorkspaceContext,
): PolicyResult {
  try {
    const normalized = normalizeBash(source, ctx);
    if (!normalized.ok) return denied(normalized.reason);

    const units: DecisionUnit[] = [];
    for (const node of normalized.assignments)
      units.push(finalize(recognizeAssignment(node), ctx, ctx.cwd));
    for (const node of normalized.declarations)
      units.push(finalize(recognizeDeclaration(node), ctx, ctx.cwd));
    for (const node of normalized.commands) {
      const cwd = normalized.cwdFor(node);
      units.push(
        finalize(recognizeCommand(node, invocation(node), ctx, cwd), ctx, cwd),
      );
    }
    for (const node of normalized.redirects) {
      const cwd = normalized.cwdFor(node);
      units.push(finalize(recognizeRedirect(node), ctx, cwd));
    }

    const rejected = units.find((unit) => unit.action === "ask");
    if (rejected) return { action: "ask", reason: rejected.reason, units };
    const mutations = units.flatMap((unit) => unit.mutationScopes);
    const dependencies = units.flatMap((unit) => unit.stabilityDependencies);
    if (
      mutations.some((mutation) =>
        dependencies.some((dependency) => pathsOverlap(mutation, dependency)),
      )
    )
      return {
        action: "ask",
        reason: "mutation overlaps stability dependency",
        units,
      };
    if (units.length === 0) return denied("no supported decision units");
    return { action: "allow", reason: "all decision units allow", units };
  } catch {
    return denied("policy engine failure");
  }
}

function denied(reason: string): PolicyResult {
  return { action: "ask", reason, units: [] };
}

function finalize(
  seed: UnitSeed,
  ctx: WorkspaceContext,
  cwd: string,
): DecisionUnit {
  const effects: readonly Effect[] = seed.effects ?? [];
  const resolved = effects.map((effect) => ({
    effect,
    path: resolvePath(effect.path, ctx, cwd),
  }));
  let situation: Situation | undefined = seed.situation;
  let allowed = seed.allowed ?? true;
  let reason = seed.reason;
  if (!situation && effects.length === 0) {
    situation = "workspace-neutral-or-indeterminate";
    allowed = false;
    reason = "missing classification facts";
  } else if (!situation)
    situation = resolved.some((item) => !item.path)
      ? "workspace-neutral-or-indeterminate"
      : resolved.some(
            (item) => !withinWorkspace(item.path!, ctx.workspace),
          )
        ? "workspace-outside"
        : "workspace-inside";
  if (situation === "workspace-outside") {
    // The sensitive-read red line (ADR-0002) is evaluated first and prevails
    // over the scratch allowance below: a sensitive read target asks even
    // when every mutation effect in the same unit targets scratch.
    if (
      resolved.some(
        (item) =>
          item.path &&
          isSensitiveTarget(item.path, ctx.homedir, ctx.extraSensitiveRoots),
      )
    ) {
      allowed = false;
      reason = "sensitive external read";
    } else if (effects.length === 0) {
      allowed = false;
      reason = "external write or unsupported external operation";
    } else if (
      effects.every((effect) => effect.kind === "read") ||
      resolved.every(
        (item) =>
          item.effect.kind === "read" ||
          (item.path !== undefined &&
            isScratchDescendant(item.path, ctx.scratchRoots ?? [])),
      )
    ) {
      // All-read external reads keep today's allowance; otherwise the
      // ADR-0004 scratch allowance admits a unit whose every mutation
      // effect targets a strict descendant of a designated scratch root.
      // Strict descent is also the scratch-root deletion red line: a delete
      // or move-source on a root itself falls through to the ask below.
    } else {
      allowed = false;
      reason = resolved.some(
        (item) =>
          item.path &&
          (item.effect.kind === "delete" ||
            item.effect.kind === "move-source") &&
          isScratchRoot(item.path, ctx.scratchRoots ?? []),
      )
        ? "scratch root removal"
        : "external write or unsupported external operation";
    }
  } else if (situation === "workspace-neutral-or-indeterminate") {
    allowed &&= seed.allowed === true;
  } else {
    for (const item of resolved) {
      if (!item.path) {
        allowed = false;
        reason = "unresolved path";
        break;
      }
      if (item.effect.kind !== "read" && hasGitSegment(item.path)) {
        allowed = false;
        reason = "direct .git mutation";
        break;
      }
      if (
        ["delete", "move-source"].includes(item.effect.kind) &&
        samePath(item.path, ctx.workspace)
      ) {
        allowed = false;
        reason = "workspace root removal";
        break;
      }
    }
  }

  const mutations = resolved
    .filter((item) => item.path && item.effect.kind !== "read")
    .map((item) => item.path!);
  return {
    kind: seed.kind,
    text: seed.text,
    situation,
    action: allowed ? "allow" : "ask",
    reason,
    mutationScopes: [...new Set(mutations)],
    stabilityDependencies: [...new Set(seed.dependencies ?? [])],
  };
}
