export type Situation =
  | "workspace-inside"
  | "workspace-outside"
  | "workspace-neutral-or-indeterminate";

export type BaselineStatus = "clean" | "dirty" | "absent" | "unknown";

export interface BaselineInspector {
  status(file: string): BaselineStatus;
}

export interface WorkspaceContext {
  readonly workspace: string;
  readonly cwd: string;
  readonly homedir: string;
  readonly baseline: BaselineInspector;
}

export interface DecisionUnit {
  readonly kind: "command" | "redirect" | "assignment";
  readonly text: string;
  readonly situation?: Situation;
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

export type UnitSeed = {
  kind: DecisionUnit["kind"];
  text: string;
  effects?: Effect[];
  situation?: Situation;
  allowed?: boolean;
  reason: string;
  dependencies?: string[];
};

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
