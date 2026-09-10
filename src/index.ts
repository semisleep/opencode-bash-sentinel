import { BashSentinelPlugin } from "./plugin"

export { BashSentinelPlugin }
export { analyzeCommandPolicy, analyzeCommandString, type DangerousVerdict, type PolicyDecision, type PolicyGate } from "./policy-engine"
export { analyzeWorkspacePolicy, defaultWorkspaceContext, type DecisionUnit, type Situation, type WorkspaceContext } from "./workspace-policy"

export default BashSentinelPlugin
