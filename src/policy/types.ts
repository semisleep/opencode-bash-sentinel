export type Situation =
  | "workspace-inside"
  | "workspace-outside"
  | "workspace-neutral-or-indeterminate";

export type BaselineStatus = "clean" | "dirty" | "absent" | "unknown";

export interface BaselineInspector {
  status(file: string): BaselineStatus;
  /**
   * File content as committed at the baseline commit; undefined when the
   * capability is unavailable or the file is not in the baseline. Optional so
   * partial inspectors keep workflows that need it fail-closed.
   */
  committedText?(file: string): string | undefined;
}

export interface WorkspaceContext {
  readonly workspace: string;
  readonly cwd: string;
  readonly homedir: string;
  readonly baseline: BaselineInspector;
  /** Additive sensitive-read roots unioned with the ADR-0002 defaults. */
  readonly extraSensitiveRoots?: readonly string[];
  /** ADR-0004 scratch roots: external mutations allow only strictly inside. */
  readonly scratchRoots?: readonly string[];
}

export interface DecisionUnit {
  readonly kind: "command" | "redirect" | "assignment";
  readonly text: string;
  readonly situation: Situation;
  readonly action: "allow" | "ask";
  readonly reason: string;
  readonly mutationScopes: readonly string[];
  readonly stabilityDependencies: readonly string[];
}

export interface PolicyResult {
  readonly action: "allow" | "ask";
  readonly reason: string;
  readonly units: readonly DecisionUnit[];
}

export type Effect = {
  kind: "read" | "write" | "delete" | "move-source" | "move-destination";
  path: string;
};

type SeedBase = {
  kind: DecisionUnit["kind"];
  text: string;
  reason: string;
  dependencies?: string[];
};

export type UnitSeed =
  | (SeedBase & {
      effects: [Effect, ...Effect[]];
      situation?: never;
      allowed?: boolean;
    })
  | (SeedBase & {
      effects?: never;
      situation: "workspace-neutral-or-indeterminate";
      allowed: boolean;
    });

export type Word = { raw: string; literal?: string };

export type Invocation = {
  executable: Word;
  args: Word[];
  assignments: string[];
};

export type CommandProfile = (
  node: import("../parser/node").SyntaxNode,
  invocation: Invocation,
  ctx: WorkspaceContext,
  cwd: string,
  name: string,
) => UnitSeed;
