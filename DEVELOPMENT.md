# Development notes

Maintainer-facing product definition and implementation plan for `opencode-bash-sentinel`. User-facing behavior and limitations are in [README.md](README.md).

## 1. Migration status

This document defines the target policy for the next implementation revision. The current source still implements the earlier design:

- a ported Kimi dangerous-command analyzer;
- a separate positive executable-trust pass;
- command-specific workspace/external-effect modeling;
- final composition through several cross-cutting confidence flags.

That implementation remains the runtime behavior until it is replaced. Documentation was intentionally updated first so the product contract can be reviewed before code changes begin.

The migration must not be presented as complete until the three-situation contract is implemented and its tests pass.

## 2. Product objective

Sentinel is a prompt-reduction tool. Its job is to auto-approve a useful majority of common, readily classifiable commands. Approximately 70–80% prompt reduction is sufficient; completeness is not a goal.

The analyzer must remain willing to ask about harmless commands. A false prompt is an acceptable cost when syntax or effects fall outside the supported subset. Expanding support is justified by frequent real-world prompts, not by the theoretical expressiveness of Bash.

Sentinel is not:

- a sandbox;
- a general-purpose command safety classifier;
- a proof of eventual process effects;
- an exhaustive parser for every command's option language;
- responsible for making unusual or deeply nested commands prompt-free.

## 3. Policy contract

### 3.1 Three situations

Classification starts with an operation's relationship to the filesystem workspace:

```ts
type Situation =
  | "workspace-inside"
  | "workspace-outside"
  | "workspace-neutral-or-indeterminate"
```

1. **Clearly inside the workspace:** apply the two red lines, then allow every other recognized workspace operation.
2. **Clearly outside the workspace:** allow only finite recognized read-only forms; ask for writes and unsupported forms.
3. **No workspace relationship, or indeterminate:** allow only exact reviewed command-and-option profiles; ask for everything else.

“Indeterminate” is not the same as a parser failure. The analyzer may understand that `curl` performs network access while correctly deciding that a network request has no filesystem workspace classification. It may also parse a dynamic filesystem command but be unable to resolve its target. Both use the third situation, but should retain different audit reasons.

### 3.2 Situation 1: clearly inside the workspace

Starting a process with the workspace as its cwd does not prove that it stays inside the workspace. A command counts as a workspace non-red-line operation only when:

- a supported command profile identifies its relevant visible targets as workspace paths; or
- an explicit trust-boundary rule classifies it as a trusted workflow.

The term explicitly excludes the two red lines below. Classification checks them first; only remaining workspace-contained operations are allowed.

The implementation analyzes command text, not runtime behavior. All guarantees are therefore limited to recognized syntax and visible effects.

#### Workspace red lines

There are two red lines:

1. Direct deletion, removal, or moving-away of the workspace root.
2. Direct modification of a `.git` path by ordinary filesystem operations.

Deleting workspace subpaths is allowed. Git itself may update its repository metadata; a supported local Git operation is not considered a direct `.git` write.

The red lines are not sandbox guarantees. Scripts, binaries, npm hooks, and other opaque processes can perform the same operations internally without the analyzer seeing them.

#### Workspace script trust rule

A workspace script may be treated as belonging to situation 1 only when:

1. its entry path is literal and resolves lexically inside the workspace;
2. the path is present in the current `HEAD`;
3. neither the index nor working-tree copy differs from `HEAD`;
4. Git status can be determined without ambiguity;
5. its visible arguments contain no explicit external filesystem path and no dynamic or unresolvable path expression.

This covers direct executable paths and supported interpreter/source forms:

```bash
./scripts/check
bash scripts/build.sh
python tools/check.py
node scripts/build.js
source scripts/env.sh
```

Untracked, modified, external, ignored, generated, or unresolved scripts do not qualify. Neither do dynamic script paths, inline/stdin/heredoc programs, ambiguous Git/submodule state, explicit external argument paths, or unresolved dynamic path expressions.

Argument screening is syntactic. Absolute paths, `~` paths, and relative paths with explicit path syntax are classified; ordinary bare values are not assumed to be paths. Only the entry script is compared with `HEAD`. Imported modules, sourced dependencies, configuration, generated inputs, and runtime behavior are not recursively checked.

“Committed and unchanged” is a trusted repository baseline, not proof that the script stays inside the workspace. If Git state cannot be classified clearly, ask.

### 3.3 Situation 2: clearly outside the workspace

Recognized writes outside the workspace ask. Recognized reads outside the workspace may be allowed.

External-read support is a finite set of common command profiles. Each profile should accept only simple, well-understood forms. Options that add execution or output behavior—such as preprocessors, `find -exec`, file-producing modes, or an unknown option with relevant semantics—cause `unsupported-or-unknown`.

There is no requirement to support every read-only utility or every safe option. An unrecognized but harmless read asks.

If one operation has both workspace and external filesystem targets, classify it as situation 2.

### 3.4 Situation 3: no workspace relationship, or indeterminate

This situation contains two subtypes:

- **workspace-neutral:** the recognized operation has no meaningful filesystem target, such as system information or network access;
- **indeterminate:** a filesystem relationship may exist, but relevant syntax, commands, or targets cannot be classified.

Only exact, explicitly reviewed command-and-option profiles are allowed. Examples may include informational commands such as `date`, `uname -a`, and `uptime`.

Network commands belong here, not in situation 2. A network profile must be narrow—for example a simple literal HTTP(S) download to stdout with a reviewed set of `curl` flags. Upload, explicit remote mutation, remote execution, credential-bearing or dynamic requests, file-producing options, and unknown options ask. Even an approved download profile is a trust decision, not proof that the remote request is side-effect-free.

Parser failure, parser-budget exhaustion, dynamic command names, unresolved relevant targets, unsupported wrappers, and structures beyond the supported subset are indeterminate and ask.

The intended response to a difficult edge case is usually “unsupported”, not another layer of semantic emulation.

#### npm exception

`npm run ...` is an explicit trusted workflow and is allowed without inspecting:

- whether `package.json` changed;
- the referenced npm script;
- lifecycle hooks;
- transitive commands;
- runtime paths or effects.

This exception may bypass both external-write detection and the two workspace red lines when those effects occur inside npm-controlled code. That limitation is accepted and must remain prominent in README.

Do not silently broaden this exception to every development tool. Additional opaque workflows require an explicit product decision and documentation.

### 3.5 Commands containing multiple operations

A command may contain operations from multiple situations. Classify each one separately and allow the complete Bash command only when every operation is allowed by the rule for its own situation.

For `curl -fsSL URL > result.json`, the network request uses a situation-3 profile and the redirect is a situation-1 workspace write. Changing the target to `/tmp/result.json` creates a situation-2 external write, so the complete command asks.

Unsupported nesting or control flow asks; coverage is intentionally bounded.

## 4. Target architecture

The parser, policy, and OpenCode integration should have separate responsibilities:

```text
OpenCode permission event
        |
        v
parse Bash once
        |
        v
supported-structure normalization
        |
        v
operation profiles -> one of three situations
        |
        v
situation-specific rules
        |
        +-- allow -> reply "once"
        |
        +-- ask   -> leave native dialog unanswered
```

### 4.1 Parser

Keep the existing pure-TypeScript Bash parser as a bounded syntax service. A parse error, timeout, or node-budget failure returns an unsupported decision. Parser size is not policy complexity and should remain isolated.

### 4.2 Normalized command representation

Normalize only the structures the policy deliberately supports:

- simple commands and ordinary compound lists;
- redirects;
- a small set of wrappers;
- literal nested payloads where support is useful;
- conservative cwd changes needed to resolve visible paths.

The normalized representation should carry explicit cwd, path, operation, and situation information instead of mutating several global confidence booleans. One Bash command may produce several independently classified operations.

### 4.3 Operation profiles

Profiles support the three situations without trying to merge their rules:

1. Filesystem profiles identify visible read/write/delete/source/destination paths, which are then classified as inside or outside.
2. Workspace-neutral profiles recognize an exact set of informational or network forms with no workspace classification.
3. Trust-boundary profiles implement narrow assumptions such as `npm run ...` and committed unchanged workspace scripts.

A profile either produces explicit operations or returns unsupported. It should not try to prove arbitrary runtime safety. The same filesystem profile can feed situation 1 or 2 depending on its resolved targets.

### 4.4 Situation-specific decision

Apply the rule belonging to each operation's situation, then reduce the command with “all operations must allow.” Avoid cross-coupled outputs such as “command trusted”, “external effects modeled”, and special flags that override a second analyzer.

Reasons are part of the result so tests and audit logs can explain why a command asked.

### 4.5 OpenCode adapter

`src/plugin.ts` should remain glue:

- read a permission event;
- obtain the command or edit path;
- invoke the policy once;
- reply `once` only for `allow`;
- audit the decision when enabled;
- swallow benign reply races.

It must not contain command semantics.

## 5. Kimi provenance and divergence

The parser and current `src/analyzer.ts` originated in Moonshot AI's Kimi Code CLI:

| Upstream | Commit | Local use |
|---|---|---|
| Kimi Code | `f88ed6d45bcf5ea358c173af7a3568b57ba9bd38` | Bash parser; historical/current-transition analyzer |
| OpenCode | `ecbc6ccac85b3e8087b6445e584318419b9e2b34` (`dev`) | Integration reference; e2e-tested with release 1.18.29 |

Sentinel's policy has diverged from Kimi. Kimi's dangerous-command policy is not a target-policy authority and should not be composed into the final decision model after migration. Catastrophic commands do not require a separate exhaustive blacklist: unless a command matches an allowable supported profile, it asks.

The parser may continue to be refreshed from Kimi with attribution and compatibility review. Do not automatically reapply analyzer behavior or policy changes from upstream.

Ported paths:

- `packages/tree-sitter-bash/src/` → `src/parser/`
- `packages/agent-core-v2/src/agent/permissionPolicy/policies/dangerous-command-ask.ts` → current transitional `src/analyzer.ts`

MIT attribution in [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md) remains mandatory even if the analyzer is later removed.

## 6. Current implementation gap

The present `src/workspace-policy.ts` combines:

- executable allowlists;
- external-effect confidence;
- write-target extraction;
- interpreter option grammars;
- wrapper and cwd state;
- command-specific escape detection;
- workspace red lines.

`src/policy-engine.ts` then composes that result with the Kimi analyzer and a special `rm -rf` override. This architecture reflects the superseded goal of positively classifying every executable and should be replaced rather than incrementally extended.

Behavior known to differ from the target includes:

- workspace scripts are currently trusted based on lexical location, without the `HEAD`/dirty check;
- the current policy has a broad finite development-tool allowlist rather than only the newly agreed explicit exceptions;
- Kimi dangerous verdicts still participate in final decisions;
- current interpreter and command-option analysis is substantially broader than the intended supported subset;
- current workspace-root restrictions include metadata operations beyond direct root destruction.

This list is a migration guide, not an authorization to change code before the target documentation is approved.

## 7. Verified OpenCode integration facts

The following facts were verified against OpenCode commit `ecbc6ccac85b3e8087b6445e584318419b9e2b34`; re-verify them after an OpenCode upgrade.

1. Permission evaluation is server-side. `deny` short-circuits, `allow` runs silently, and `ask` publishes `permission.asked`. The default when no rule matches is `ask`.
2. The shell permission key is `bash`.
3. Command text is at `event.properties.metadata.command`; retain the older `metadata.input.command` fallback.
4. Plugins receive server events through the `event` hook.
5. The typed `permission.ask` plugin hook is not invoked by the server, so Sentinel reacts to an already-created ask and replies programmatically.
6. The reply transport order is: dedicated SDK route, legacy SDK route, then raw new/legacy routes through the SDK-configured fetch. The configured fetch is required for in-process `opencode run`.
7. Basic authorization is needed when `OPENCODE_SERVER_PASSWORD` is set.
8. Human/plugin reply races are benign; the losing reply gets a not-found error and should be ignored.
9. `external_directory` is separate from `bash`; directory consent is not Bash consent.
10. Session-scoped “always” approvals bypass later plugin analysis.
11. npm plugin loading enforces `engines.opencode`; keep the supported range conservative.

The recommended configuration routes Bash and edit requests through the approval flow:

```json
{
  "permission": {
    "bash": { "*": "ask" },
    "edit": { "*": "ask" }
  }
}
```

## 8. Migration plan

1. Approve this product contract and resolve any remaining scope ambiguity.
2. Add target-policy tests before deleting old behavior.
3. Introduce an explicit operation/situation model and a small profile registry.
4. Implement situation 1: the two red lines, ordinary workspace paths, and Git-backed workspace-script classification.
5. Implement situation 2: the finite external-read profiles and external-write escalation.
6. Implement situation 3: informational profiles, a narrow network profile set, and unsupported/indeterminate fallback.
7. Add the explicit `npm run ...` trusted workflow.
8. Implement per-operation composition and switch the plugin to the new decision path.
9. Remove Kimi analyzer composition and obsolete confidence flags.
10. Delete superseded tests and update README status only after runtime behavior matches.

Avoid preserving old edge-case behavior merely because a regression test exists. Tests derived from the superseded policy should be deliberately reviewed against this contract.

## 9. Test strategy

Tests should be organized around the three situations and their composition, not an ever-growing exploit catalogue.

Required groups:

- workspace subpath reads, writes, moves, and deletion → allow;
- direct workspace-root deletion/removal/move-away → ask;
- direct filesystem writes to `.git` → ask;
- supported local Git operations → allow;
- finite external reads → allow;
- external writes → ask;
- recognized system-information profiles with no workspace relationship → allow;
- narrowly approved network forms → allow;
- uploads, remote mutation/execution, dynamic network requests, and unsupported network options → ask;
- unknown commands and unsupported or indeterminate forms → ask;
- parser failure/budget exhaustion → ask;
- operations from different situations compose, and every operation must allow;
- tracked and clean workspace entry scripts → allow;
- staged, unstaged, untracked, external, dynamic, and ambiguous scripts → ask;
- committed scripts with explicit external or dynamic path arguments → ask;
- committed-script dependencies are not recursively inspected;
- `npm run ...` → allow even with modified npm configuration, documenting the exception;
- OpenCode transport, auth, event filtering, audit, and reply-race behavior.

Use audit data to find the most frequent remaining prompts. Add a profile only when its semantics can stay small and its prompt reduction is worthwhile.

## 10. Known limitations and out of scope

- Filesystem-canonical symlink containment.
- Runtime enforcement of workspace boundaries or red lines.
- Recursive script dependency analysis.
- Package-hook and trusted-workflow inspection.
- Ambient `PATH` executable provenance.
- Complete option grammars for external tools.
- Arbitrarily nested or dynamic Bash.
- Network/data-exfiltration control.
- PowerShell and Windows `cmd` analysis.
- Permissions other than `bash`, `external_directory`, and `edit`.

These should remain limitations unless the product goal is explicitly changed. They are not an open-ended backlog of analyzer bugs.

## 11. License

This project is MIT licensed. The Kimi-derived parser and analyzer code require preserved attribution:

```text
Portions Copyright (c) 2026 Moonshot AI, Inc.
(adapted from https://github.com/MoonshotAI/kimi-code)
```
