export { analyzeWorkspacePolicy } from "./policy/analyze";
export { defaultWorkspaceContext } from "./policy/baseline";
export { hasGitSegment, stripTrailingSeparators, withinWorkspace } from "./policy/paths";
export { isSensitiveTarget } from "./policy/sensitive";
export { isScratchDescendant, isScratchRoot } from "./policy/scratch";
export type {
  BaselineInspector,
  BaselineStatus,
  DecisionUnit,
  PolicyResult,
  Situation,
  WorkspaceContext,
} from "./policy/types";
