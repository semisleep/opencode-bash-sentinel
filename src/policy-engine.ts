import {
  analyzeWorkspacePolicy,
  defaultWorkspaceContext,
  type WorkspaceContext,
} from "./workspace-policy";

export type PolicyGate = "bash" | "external_directory";
export type DangerousVerdict =
  | { readonly kind: "dangerous"; readonly command: string }
  | { readonly kind: "unanalyzable" };
export type PolicyDecision =
  | { readonly action: "allow" }
  | {
      readonly action: "ask";
      readonly verdict: DangerousVerdict;
      readonly reason: string;
    };

/** Both OpenCode command gates deliberately use this exact same pipeline. */
export function analyzeCommandPolicy(
  source: string,
  ctx: WorkspaceContext,
  _options: { readonly gate?: PolicyGate } = {},
): PolicyDecision {
  const result = analyzeWorkspacePolicy(source, ctx);
  return result.action === "allow"
    ? { action: "allow" }
    : {
        action: "ask",
        verdict: { kind: "unanalyzable" },
        reason: result.reason,
      };
}

/** Compatibility API; the plugin should always pass OpenCode's explicit workspace instead. */
export function analyzeCommandString(
  source: string,
  ctx: WorkspaceContext = defaultWorkspaceContext(process.cwd()),
): DangerousVerdict | undefined {
  const decision = analyzeCommandPolicy(source, ctx);
  return decision.action === "allow" ? undefined : decision.verdict;
}
