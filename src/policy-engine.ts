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
  readonly upstream?: boolean
  readonly gate?: PolicyGate
}

/**
 * Single entry point for command decisions. The source is parsed once and the
 * same syntax tree is shared by the upstream and workspace policies.
 */
export function analyzeCommandPolicy(
  source: string,
  ctx: WorkspaceContext,
  options: PolicyEngineOptions = {},
): DangerousVerdict | undefined {
  try {
    const parsed = parseSource(source)
    const upstream = analyzeParsedSource(parsed, 0, parseSource)
    if (options.upstream === true) return upstream

    const workspace = analyzeWorkspaceParsed(parsed, ctx)
    if (workspace.verdict !== undefined) return workspace.verdict
    if (options.gate === 'external_directory' && !workspace.externalSafe) {
      return { kind: 'dangerous', command: 'external_directory: unmodeled command effects' }
    }
    if (workspace.suppressUpstreamRmRf && upstream?.kind === 'dangerous' && upstream.command === 'rm -rf') {
      return undefined
    }
    return upstream
  } catch {
    return { kind: 'unanalyzable' }
  }
}
