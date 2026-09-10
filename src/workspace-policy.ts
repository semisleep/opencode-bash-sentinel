export { analyzeWorkspacePolicy } from "./policy/analyze";
export { defaultWorkspaceContext } from "./policy/baseline";
export { hasGitSegment, withinWorkspace } from "./policy/paths";
export type {
  BaselineInspector,
  BaselineStatus,
  DecisionUnit,
  PolicyResult,
  Situation,
  WorkspaceContext,
} from "./policy/types";
