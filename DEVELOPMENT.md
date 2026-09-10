# Development notes

Maintainer-facing target-policy detail, current profile registry, and implementation plan for `opencode-bash-sentinel`. The normative product model, architectural invariants, extension contract, and change process are in [ARCHITECTURE.md](ARCHITECTURE.md). User-facing behavior and limitations are in [README.md](README.md).

An ordinary command/profile change may update the finite sets in this document but must satisfy the architecture extension contract. It must not change a core invariant or trust boundary. If this document conflicts with `ARCHITECTURE.md` on the decision model, the architecture constitution controls.

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

### 3.1 Recognition and three situations

This section instantiates the normative pipeline and situation contract from [ARCHITECTURE.md](ARCHITECTURE.md). Its decision order and fail-closed behavior are architectural; the finite command sets below are extensible current profiles.

The parser and structural normalization layer first produce decision units for executable command nodes and explicit redirects. A finite recognizer must accept each unit's complete invocation shape and produce explicit facts such as path effects, profile family, mutation scopes, and stability dependencies. Classification maps those facts to a situation; it is not a second universal attempt to guess which arguments look like paths.

```ts
type Situation =
  | "workspace-inside"
  | "workspace-outside"
  | "workspace-neutral-or-indeterminate"
```

1. **Clearly inside the workspace:** apply the three red lines, then allow every other recognized workspace command.
2. **Clearly outside the workspace:** allow only finite recognized read-only forms; ask for writes and unsupported forms.
3. **No workspace relationship, or indeterminate:** allow only exact reviewed command-and-option profiles; ask for everything else.

Only a finite path recognizer may produce the path facts that place a command in situation 1 or 2. It matches a supported executable and complete invocation shape, identifies the roles of its relevant path operands, and stops at the first unsupported option or construct. Unknown commands and unsupported forms go directly to situation 3 even when an argument resembles a path. Git, network, informational, and development-workflow recognizers instead produce explicit situation-3 profile candidates.

“Indeterminate” is not the same as a parser failure. The analyzer may understand that `curl` performs network access while correctly deciding that it has no filesystem workspace classification. It may also parse a dynamic filesystem command but be unable to resolve its target. Both use situation 3, but retain different audit reasons.

### 3.2 Situation 1: clearly inside the workspace

Starting a process with the workspace as its cwd does not prove that it stays inside the workspace. A command enters situation 1 only when:

- a finite path recognizer accepts the complete invocation shape; and
- every path that recognizer considers relevant resolves inside the workspace.

Relative explicit paths are resolved from the OpenCode-provided cwd. A path-free command is not inferred to be a workspace command merely because that cwd is the workspace.

After classification, the three red lines below are checked; every remaining situation-1 command is allowed without another allow profile.

The implementation analyzes command text, not runtime behavior. All guarantees are therefore limited to recognized syntax and visible effects.

#### Workspace red lines

There are three red lines:

1. Direct deletion, removal, or moving-away of the workspace root.
2. Direct modification of a `.git` path by ordinary filesystem operations.
3. Execution of a workspace script whose entry file is not committed and unchanged relative to `HEAD`, whose Git state cannot be confirmed, or whose visible arguments contain an explicit external or unresolved path.

Deleting workspace subpaths is allowed. Git itself may update its repository metadata; a supported local Git operation is not considered a direct `.git` write.

Matching a red line produces an `ask` decision: Sentinel sends no approval reply, so OpenCode's native dialog remains for the user. The red lines are not sandbox guarantees. Scripts, binaries, package hooks, and other opaque processes can perform the same operations internally without the analyzer seeing them.

#### Workspace script trust rule

A supported direct script invocation is classified from its entry-script path. An entry path that resolves inside the workspace places the invocation in situation 1; it avoids the third red line only when:

1. its entry path is literal and resolves lexically inside the workspace;
2. the path is present in the current `HEAD`;
3. neither the index nor working-tree copy differs from `HEAD`;
4. Git status can be determined without ambiguity;
5. its visible arguments contain no explicit external filesystem path and no dynamic or unresolvable path expression.

Only the entry-script path participates in situation classification. The script recognizer defines its own visible-argument checks as part of the third red line; those operands are not fed into a generic path classifier and do not require a second cross-cutting path-fact system.

This covers direct executable paths and supported interpreter/source forms:

```bash
./scripts/check
bash scripts/build.sh
python tools/check.py
node scripts/build.js
source scripts/env.sh
```

Untracked, modified, ignored, or generated workspace scripts do not qualify. Neither do ambiguous Git/submodule state, explicit external argument paths, or unresolved dynamic path expressions. An external entry script is situation 2. An unresolved or dynamic entry path and inline/stdin/heredoc program are situation 3. The initial profiles ask for all of those non-workspace forms independently of the workspace red line.

Argument screening is syntactic. Absolute paths, `~` paths, and relative paths with explicit path syntax are classified; ordinary bare values are not assumed to be paths. Only the entry script is compared with `HEAD`. Imported modules, sourced dependencies, configuration, generated inputs, and runtime behavior are not recursively checked.

“Committed and unchanged” is a trusted repository baseline, not proof that the script stays inside the workspace. If Git state cannot be classified clearly, ask.

For `source FILE` and `. FILE`, apply the same entry-file checks. After approval, do not model changes the sourced file may make to cwd, variables, functions, aliases, shell options, or later command interpretation. Those effects are accepted as part of trusting the committed entry file. In particular, do not introduce a cross-unit shell-state simulator or automatically ask merely because another command follows `source`.

### 3.3 Situation 2: clearly outside the workspace

Recognized writes outside the workspace always ask. A recognized read is allowed only when its complete invocation matches one of the finite external-read profiles; every other situation-2 command asks.

External-read support is a finite set of common command profiles. Each profile should accept only simple, well-understood forms. Options that add execution or output behavior—such as preprocessors, `find -exec`, file-producing modes, or an unknown option with relevant semantics—cause `unsupported-or-unknown`.

The identities and exact option sets of those external-read profiles form part of the current extensible registry. The situation-2 rule itself does not.

There is no requirement to support every read-only utility or every safe option. An unrecognized but harmless read asks.

If one recognized command has both workspace and external filesystem targets, classify the whole command unit as situation 2. Do not split sources and destinations merely to recover additional allow cases: for example, both `cp /tmp/input .` and `mv /tmp/input .` may conservatively require user approval when no exact situation-2 profile accepts them.

### 3.4 Situation 3: no workspace relationship, or indeterminate

This situation contains two subtypes:

- **workspace-neutral:** the recognized operation has no meaningful filesystem target, such as system information or network access;
- **indeterminate:** a filesystem relationship may exist, but relevant syntax, commands, or targets cannot be classified.

Only exact, explicitly reviewed command-and-option profiles are allowed.

#### Current informational and network profiles

The following names and option sets are an extensible **CURRENT PROFILE** registry. The situation-3 exact-match requirement is architectural.

The initial informational family covers bounded ordinary forms of `date`, `uname`, `uptime`, `whoami`, `id`, `free`, `vm_stat`, `nproc`, `lscpu`, and `ps`, plus plain stdout-only `echo` and `printf` forms. Each implementation profile must enumerate accepted flags; an unknown flag returns unsupported. In particular, the `printf` profile must reject assignment forms such as `printf -v`.

Network commands belong here, not in situation 2. The initial network family contains `curl` only:

- one literal `http://` or `https://` URL;
- default GET or `-I/--head`;
- stdout output only;
- combinable `-f/--fail`, `-s/--silent`, `-S/--show-error`, `-L/--location`, `--compressed`, and numeric `--connect-timeout`, `--max-time`, `--retry`, and `--retry-delay`.

Upload, explicit remote mutation, remote execution, credential/cookie/header/body options, dynamic URLs, curl file-output options, non-HTTP(S) schemes, multiple URLs, and unknown options ask. Bash redirects remain separate decision units. Curl's `.curlrc`, proxy environment, DNS, and other ambient state are not inspected; this is an explicit trust boundary.

Parser failure, parser-budget exhaustion, dynamic command names, unresolved relevant targets, unsupported wrappers, and structures beyond the supported subset are indeterminate and ask.

The intended response to a difficult edge case is usually “unsupported”, not another layer of semantic emulation.

#### Current Git profiles

The exact subcommand and option sets below are extensible **CURRENT PROFILES**. Keeping Git in situation 3 and refusing unknown forms are architectural decisions.

Every Git invocation belongs to situation 3, even when it has path operands or starts from the OpenCode workspace. This deliberately avoids inferring repository scope from ambient cwd.

The initial ordinary-form allow set is `status`, `diff`, `log`, `show`, `blame`, `rev-parse`, `ls-files`, `grep`, `add`, `commit`, and `fetch`. Each subcommand profile accepts only an enumerated flag/operand shape.

`git -C DIR` remains situation 3 but adds a constraint. A literal workspace directory may use the normal set; a literal external directory may use only `status`, `diff`, `log`, `show`, `blame`, `rev-parse`, `ls-files`, and `grep`. Dynamic `-C`, `--git-dir`, `--work-tree`, and unknown global options ask.

`push`, `pull`, `reset`, `clean`, `checkout`, `switch`, `restore`, credential/configuration mutation, and every unlisted subcommand ask in the initial policy. Git hooks, aliases, filters, configuration, and repository selection affected by ambient state are not recursively inspected.

#### Current environment-assignment profile

The default treatment of Bash assignment syntax is part of the documented trust model. The high-risk names are an extensible **CURRENT PROFILE** registry: adding a conservative denial is an ordinary extension, while removing one requires explicit policy review.

Leading Bash `NAME=value` assignments are allowed and ignored while classifying the associated executable. Standalone assignments and recognized assignment forms of `export`, `declare`, `typeset`, and `readonly` are also allowed. Both rules exclude this fixed high-risk name set:

`PATH`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, names beginning with `DYLD_`, `BASH_ENV`, `ENV`, `ZDOTDIR`, `GIT_DIR`, `GIT_WORK_TREE`, `HOME`, `CDPATH`, `NODE_OPTIONS`, `PYTHONPATH`, `PYTHONSTARTUP`, `RUBYOPT`, `RUBYLIB`, and `PERL5OPT`.

Apply the set to direct assignments and recognized `export`, `declare`, `typeset`, and `readonly` assignment forms. Assigning a high-risk name asks because it can change executable identity, preload code, or redirect path/repository resolution. Tool-specific environment variables outside this short set are deliberately not modeled. Command substitutions inside an assignment remain real AST command units and must independently allow.

The `env ... COMMAND` executable is not assignment syntax. It is an unsupported wrapper in the initial policy.

#### Current development-workflow profiles

The ecosystems, subcommands, options, and direct control-file mappings below are extensible **CURRENT PROFILES**. Trusting only explicitly checked direct control files, and treating all other behavior as opaque, is an architectural trust boundary.

A finite set of conventional development workflows is allowed only when:

1. its command and subcommand match a reviewed profile;
2. every required control file exists in `HEAD`;
3. none of those files has a staged or unstaged change;
4. every visible path option covered by the profile satisfies that profile's path rule.

“Required control file” means only the profile's direct entry file in the effective workspace directory. Do not recursively discover workspace configuration, included Makefiles or requirements, build scripts, hooks, or transitive metadata. Alternate workspace/root selectors that the profile does not explicitly support ask.

Initial target profiles:

- **Node scripts:** `npm run ...`, `npm test`, `pnpm run ...`, `yarn run ...`, and `bun run ...`. Require the effective workspace's `package.json` to be committed and unchanged. Alternate prefix/workspace selectors ask initially.
- **Go:** `go build`, `go test`, `go vet`, `go fmt`, `go mod download`, and `go mod tidy`. Require `go.mod` and, when present, `go.sum` to be committed and unchanged. Explicit output or directory paths are still classified normally.
- **Python/pip information:** `pip list`, `pip show`, `pip check`, and `pip freeze`, including `python -m pip` equivalents. These exact informational profiles need no project control file.
- **Python/pip installation:** `pip install -r FILE` requires that requirements file to be committed and unchanged. `pip install .` requires every present packaging control file among `pyproject.toml`, `setup.cfg`, and `setup.py` to be committed and unchanged, with at least one present in `HEAD`. The same rules apply to `python -m pip`.
- **Rust:** `cargo build`, `cargo test`, `cargo check`, `cargo fmt`, and `cargo clippy`. Require `Cargo.toml` and, when present, `Cargo.lock` to be committed and unchanged.
- **Make:** `make` with zero or more literal, non-assignment targets and optional numeric `-j/--jobs`. Require the selected makefile—an explicit literal in-workspace `-f/--file` target or the applicable `GNUmakefile`/`Makefile`—to be committed and unchanged. Other options ask initially.

These profiles trust only the committed workflow definition. They do not recursively inspect lifecycle hooks, transitive commands, modified source code executed by tests or generators, runtime filesystem effects, or network behavior. Those opaque effects may bypass external-write checks and the syntax-level red lines.

A missing, untracked, modified, or ambiguous required control file produces `ask`. Do not silently broaden this set to an executable's other subcommands. Additional workflows require an explicit product decision, documentation, and tests.

### 3.5 Commands containing multiple decision units

A Bash source may contain command nodes and redirects from multiple situations. Classify each decision unit separately, then apply the source-level completeness and stability invariants below.

For `curl -fsSL URL > result.json`, the curl command uses a situation-3 profile and the redirect is a situation-1 workspace write. Changing the target to `/tmp/result.json` creates a situation-2 external write, so the complete source asks.

Executable commands, redirects, and nested executable nodes such as command substitutions become decision units when represented by the Bash AST. Every execution- or I/O-relevant AST node must be consumed by a supported normalization rule or make the complete source unsupported. Approval is forbidden when normalization leaves a relevant node or construct unaccounted for. This full-consumption invariant prevents parser additions and uncommon syntax from becoming silent policy gaps.

All redirect operators must be classified explicitly. Treat `<>` and analogous read-write forms as writes. Bash network paths such as `/dev/tcp/...` and `/dev/udp/...`, dynamic file-descriptor paths such as `/dev/fd/...` or `/proc/self/fd/...`, heredocs, here-strings, process substitutions, and any arithmetic or other expansion whose executable contents cannot be completely extracted are unsupported initially. `/dev/null` may be an exact finite exception. Do not infer that an unfamiliar external input redirect is an ordinary file read.

Do not reinterpret wrapper arguments, `sh -c` strings, `eval` text, `xargs` operands, or `find -exec` operands as nested commands. The containing invocation is unsupported as described below, so its unparsed string is not silently approved.

The initial policy has no allow profile for `sudo`, `doas`, `env ... COMMAND`, `timeout`, `watch`, `nohup`, `nice`, `stdbuf`, `xargs`, `sh -c`, other shell `-c` forms, or `eval`. They enter situation 3 and ask as whole invocations. A future high-frequency wrapper may receive one exact invocation profile, but must not introduce a generic recursive unwrapping engine.

The initial supported composition subset is limited to simple commands and redirects, ordinary pipelines, flat lists joined by newline, `;`, `&&`, or `||`, leading Bash assignments, one literal `cd DIR` transition followed by a supported command, and fully extracted command substitutions whose containing invocation remains completely recognized. For supported lists and pipelines, do not reason about which branch or process runs; every syntactically present decision unit must allow.

`if`, `for`, `while`, `until`, `case`, `select`, function definitions, background jobs, subshells, brace groups, process substitutions, dynamic cwd changes, and other structures requiring branch, scope, job-control, or shell-state analysis make the complete source unsupported in the initial policy.

#### Stability conflicts

Decision units may contribute two generic path sets:

- `mutationScopes`: paths or directory ranges whose contents, existence, or location the visible syntax may directly modify, remove, truncate, or move;
- `stabilityDependencies`: paths whose analysis-time state is a prerequisite for that unit's approval, including a trusted workspace entry script and a development workflow's checked control files.

If any mutation scope overlaps any stability dependency in the same Bash source, the complete source asks, whether the two facts come from the same decision unit or different units. Equality and ancestor/descendant coverage count as overlap. The comparison is intentionally independent of syntactic order and control flow; a conservative false prompt is preferable to simulating execution order.

For example, both `sed -i ... scripts/check.sh && ./scripts/check.sh` and `printf ... > package.json && npm run build` ask even when their individual units would otherwise allow. This prevents an approval check from relying on a file snapshot that another visible unit may invalidate before use.

Git is one current mechanism for validating a dependency's initial state, but the aggregator does not implement a Git-specific conflict. A future hash, signature, or other trust predicate can produce the same `stabilityDependencies`. Conversely, opaque mutations hidden inside an approved script, sourced file, package hook, Git hook, or development tool do not produce mutation scopes and remain within the documented runtime trust boundary.

The complete source allows only when all four conditions hold:

1. parsing and normalization succeed;
2. every execution- or I/O-relevant AST node is accounted for;
3. every decision unit allows under the rule for its situation;
4. no mutation scope overlaps a stability dependency.

### 3.6 OpenCode permission gates

OpenCode may emit `bash` and `external_directory` as separate permission requests for the same command. They are independent gates, but neither is a separate or weaker policy: both must invoke the same complete Bash analysis pipeline and satisfy the same parsing, structural-coverage, recognition, situation, red-line, all-unit, and stability-conflict requirements. Approving either request does not approve the other.

Gate-specific adapter code may translate event data and reply to OpenCode, but it must not add command semantics, skip decision units, or create an `external_directory` allow path outside the three-situation model.

### 3.7 File-edit permission

The `edit` gate is intentionally outside the Bash command architecture and will be considered separately. It does not use Bash command profiles; its current path rule is:

- a resolved ordinary path inside the workspace allows;
- a `.git` path, external path, or unresolved path asks.

Editing a script is allowed. The third workspace red line is evaluated only if that modified script is later executed.

## 4. Target architecture

This section describes an implementation of the normative model in [ARCHITECTURE.md](ARCHITECTURE.md). Module boundaries and internal types may be refactored, but the layer responsibilities and observable invariants must remain intact unless the architecture-change process is followed. The pipeline below applies to the `bash` and `external_directory` gates; `edit` remains a separate policy.

The parser, policy, and OpenCode integration should have separate responsibilities:

```text
OpenCode permission event
        |
        v
parse Bash once
        |
        v
normalize supported structure and require full AST consumption
        |
        v
finite recognizers -> decision units and explicit facts
        |
        v
facts -> situations -> situation-specific rules
        |
        v
all units allow and no stability conflict
        |
        +-- allow -> reply "once"
        |
        +-- ask   -> leave native dialog unanswered
```

### 4.1 Parser

Keep the existing pure-TypeScript Bash parser as a bounded syntax service. A parse error, timeout, or node-budget failure returns an unsupported decision. Parser size is not policy complexity and should remain isolated.

### 4.2 Normalized command representation

Normalize only the structures the policy deliberately supports:

- simple commands and redirects;
- ordinary pipelines;
- flat command lists joined by newline, `;`, `&&`, or `||`;
- leading Bash assignments;
- one literal `cd DIR` transition followed by a supported command;
- fully extracted command substitutions whose containing invocation remains completely recognized.

Do not normalize wrapper arguments or embedded strings into commands. Unsupported wrappers, nested payloads, dynamic cwd, `if`, loops, `case`, functions, background jobs, subshells, brace groups, process substitutions, and other complex control flow make the complete source unsupported and produce an ask decision.

Normalization must report whether it consumed every execution- or I/O-relevant AST node. An unconsumed relevant node makes the complete source unsupported even when all extracted units would independently allow. New parser node types therefore fail closed until normalization explicitly handles or rejects them.

The normalized representation should carry explicit cwd, invocation, redirect, and structural-coverage information instead of mutating several global confidence booleans. One Bash source may produce several decision units; recognizers add path effects, profile candidates, mutation scopes, and stability dependencies before classification assigns situations.

### 4.3 Operation profiles

Finite recognizers and profiles support the three situations without trying to merge their rules:

1. Path recognizers accept complete, simple invocation shapes and produce typed read, write, delete, move, source, and destination path facts used to choose situation 1 or 2.
2. Situation-3 recognizers produce exact informational, network, Git, and development-workflow profile candidates.
3. The workspace-script recognizer identifies only the entry path for situation classification; the checker implements the third red line, including its profile-specific visible-argument checks, with a shared committed-and-unchanged predicate.
4. Redirect recognizers create separate units and classify the complete redirect form, including whether it reads, writes, duplicates an fd, contains executable expansion, or uses a special Bash path.

A recognizer either accepts the whole supported shape and produces all required facts, or returns unsupported; partial recognition must not produce an allow. Rejection by a path recognizer must not fall through to a broader profile for the same invocation. Recognizers should not try to prove arbitrary runtime safety. The same path recognizer can feed situation 1 or 2 depending on its resolved targets.

### 4.4 Situation-specific decision

Apply the rule belonging to each decision unit's situation. The source-level aggregator then checks structural completeness, requires every unit to allow, and rejects overlaps between `mutationScopes` and `stabilityDependencies`. It does not otherwise simulate order, branches, filesystem changes, or Shell state. Avoid cross-coupled outputs such as “command trusted”, “external effects modeled”, and special flags that override a second analyzer.

Reasons are part of the result so tests and audit logs can explain why a command asked.

### 4.5 OpenCode adapter

`src/plugin.ts` should remain glue:

- read a permission event;
- obtain the command or edit path;
- invoke the shared Bash policy once for `bash` or `external_directory`, or the separate edit policy for `edit`;
- reply `once` only for `allow`;
- audit the decision when enabled;
- swallow benign reply races.

The `bash` and `external_directory` event adapters must both invoke the same policy architecture and satisfy the same allow invariants. They remain independent OpenCode requests, so approval of one never stands in for approval of the other. The `edit` adapter is separate pending its own architectural review.

The adapter must not contain command semantics.

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
- current wrappers and embedded shell payloads are recursively analyzed, while the target policy treats them as unsupported whole invocations;
- current environment-assignment behavior does not match the target short high-risk-name exception;
- Git is currently partly classified through workspace paths instead of exclusively through situation-3 profiles;
- current normalization does not expose and enforce the target full-consumption invariant for every execution- or I/O-relevant AST node;
- current aggregation does not detect overlaps between mutation scopes and stability dependencies;
- current redirect handling does not implement the target's complete redirect-form and Bash-special-path policy;
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
9. `external_directory` is separate from `bash`; directory consent is not Bash consent. Sentinel's target architecture nevertheless subjects both gates to the same Bash policy invariants.
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
3. Introduce an explicit decision-unit/fact/situation model, full-AST-consumption result, and small finite recognizer registries.
4. Implement situation 1: finite path recognizers, the three red lines, and Git-backed workspace-script classification.
5. Implement situation 2: the finite external-read profiles and external-write escalation.
6. Implement situation 3: informational, curl, Git, and unsupported/indeterminate profiles.
7. Add the finite Node, Go, pip, Cargo, and Make workflow profiles with Git-clean control-file checks.
8. Add Bash-assignment handling, the high-risk variable-name set, complete redirect handling, bounded literal `cd`, and source aggregation with stability-conflict detection.
9. Remove Kimi analyzer composition and obsolete confidence flags.
10. Delete superseded tests and update README status only after runtime behavior matches.

Avoid preserving old edge-case behavior merely because a regression test exists. Tests derived from the superseded policy should be deliberately reviewed against this contract.

Implementation must also add a distinct architecture-contract test suite covering the invariants listed in [ARCHITECTURE.md](ARCHITECTURE.md), separate from the evolving command-profile cases below.

## 9. Test strategy

Tests should be organized around the three situations and their composition, not an ever-growing exploit catalogue.

Required groups:

- workspace subpath reads, writes, moves, and deletion → allow;
- direct workspace-root deletion/removal/move-away → ask;
- direct filesystem writes to `.git` → ask;
- the exact Git allow set, including constrained `-C` and `fetch` → allow;
- Git remote mutation, destructive/unlisted subcommands, alternate repository options, and unknown flags → ask;
- finite external reads → allow;
- external writes → ask;
- mixed inside/outside commands without an exact situation-2 allow profile → ask;
- recognized system-information profiles with no workspace relationship → allow;
- narrowly approved network forms → allow;
- uploads, remote mutation/execution, dynamic network requests, and unsupported network options → ask;
- unknown commands and unsupported or indeterminate forms → ask;
- parser failure/budget exhaustion → ask;
- commands and redirects from different situations compose, and every decision unit must allow;
- any unconsumed execution- or I/O-relevant AST node → ask;
- command substitutions and other supported nested executable nodes become independent decision units;
- unsupported executable expansions, heredocs, here-strings, process substitutions, and redirect forms → ask;
- Bash `/dev/tcp` and `/dev/udp`, dynamic fd paths, and read-write external redirects → ask;
- overlapping mutation scopes and stability dependencies → ask, including file equality and directory containment;
- non-overlapping visible mutations do not create a stability conflict;
- wrappers and embedded command strings are not recursively expanded and ask;
- ordinary Bash environment assignments allow, while the fixed high-risk name set asks;
- a command substitution inside an environment value remains an independent decision unit;
- tracked and clean workspace entry scripts → allow;
- staged, unstaged, untracked, external, dynamic, and ambiguous scripts → ask;
- committed scripts with explicit external or dynamic path arguments → ask;
- committed-script dependencies are not recursively inspected;
- a committed and unchanged `source`/`.` file is allowed even when another command follows; its Shell-state effects are not modeled;
- supported Node, Go, pip, Cargo, and Make workflows with committed unchanged control files → allow;
- the same workflows with missing, staged, unstaged, untracked, or ambiguous required control files → ask;
- unlisted subcommands of an otherwise recognized development tool → ask;
- inside-workspace edits allow, while `.git`, external, and unresolved edit paths ask;
- OpenCode transport, auth, event filtering, audit, and reply-race behavior.

Use audit data to find the most frequent remaining prompts. Add a profile only when its semantics can stay small and its prompt reduction is worthwhile.

## 10. Known limitations and out of scope

- Filesystem-canonical symlink containment.
- Runtime enforcement of workspace boundaries or red lines.
- Recursive script dependency analysis.
- Shell-state changes made by an approved `source`/`.` file, including their effects on later commands in the same Bash source.
- Filesystem or Git-state changes made concurrently after analysis and before process execution.
- Package-hook and trusted-workflow inspection.
- Curl configuration, proxy environment, and remote-side-effect verification.
- Tool-specific effects of environment variables outside the fixed high-risk set.
- Ambient `PATH` executable provenance.
- Complete option grammars for external tools.
- Arbitrarily nested or dynamic Bash.
- Generic wrapper or embedded-command expansion.
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
