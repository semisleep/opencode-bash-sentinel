import {
  analyzeParsedSource,
  parseSource,
  type DangerousVerdict,
} from './analyzer'
import {
  analyzeWorkspaceParsed,
  type WorkspaceContext,
} from './workspace-policy'

export type PolicyGate = 'bash' | 'external_directory'

export interface PolicyEngineOptions {
  readonly gate?: PolicyGate
}

export type PolicyDecision =
  | { readonly action: 'allow' }
  | { readonly action: 'ask'; readonly verdict: DangerousVerdict; readonly reason: string }

/**
 * Single entry point for command decisions. The source is parsed once and the
 * same syntax tree is shared by the upstream and workspace policies.
 */
export function analyzeCommandPolicy(
  source: string,
  ctx: WorkspaceContext,
  options: PolicyEngineOptions = {},
): PolicyDecision {
  try {
    const parsed = parseSource(source)
    const upstream = analyzeParsedSource(parsed, 0, parseSource)
    const workspace = analyzeWorkspaceParsed(parsed, ctx)
    if (workspace.verdict !== undefined) {
      return { action: 'ask', verdict: workspace.verdict, reason: 'workspace policy' }
    }
    if (options.gate === 'external_directory' && !workspace.externalEffectsModeled) {
      return {
        action: 'ask',
        verdict: { kind: 'unanalyzable' },
        reason: 'external-directory effects are not fully modeled',
      }
    }
    if (workspace.suppressUpstreamRmRf && upstream?.kind === 'dangerous' && upstream.command === 'rm -rf') {
      return workspace.commandTrusted
        ? { action: 'allow' }
        : { action: 'ask', verdict: { kind: 'unanalyzable' }, reason: 'command is not positively trusted' }
    }
    if (upstream !== undefined) return { action: 'ask', verdict: upstream, reason: 'upstream dangerous-command policy' }
    if (!workspace.commandTrusted) {
      return { action: 'ask', verdict: { kind: 'unanalyzable' }, reason: 'command is not positively trusted' }
    }
    return { action: 'allow' }
  } catch {
    return { action: 'ask', verdict: { kind: 'unanalyzable' }, reason: 'policy engine failure' }
  }
}
