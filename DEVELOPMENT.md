# Development guide

This document explains how to change and verify the implementation. The stable policy model is defined by [ARCHITECTURE.md](ARCHITECTURE.md); user-facing purpose and limitations belong in [README.md](README.md).

The source and its profile-local tests are the authoritative catalogue of currently supported commands. Do not duplicate that catalogue here.

## Module ownership

```text
src/parser/                    bounded Bash syntax service
src/policy/normalize.ts        supported structure, full AST coverage, cwd facts
src/policy/types.ts            decision units and shared fact types
src/policy/paths.ts            lexical path resolution and containment
src/policy/baseline.ts         session-fixed committed-and-unchanged baseline
src/policy/sensitive.ts        sensitive-read roots for the situation-2 red line
src/policy/scratch.ts          ADR-0004 scratch roots for external mutations
src/policy/path-domain.ts      ADR-0005 gate-shared external read/mutation rules
src/policy/redirect.ts         redirect recognition
src/policy/profiles/           complete command-specific recognizers
src/policy/analyze.ts          situation rules and source aggregation
src/workspace-policy.ts        compatibility/public export facade
src/policy-engine.ts           gate-facing policy entry point
src/plugin.ts                  OpenCode 2.x in-band hook adapter
```

The boundaries are intentional:

- normalization understands Bash structure but not individual tool grammars;
- a profile owns the complete grammar and facts of its command or coherent command family;
- classification and aggregation use only shared facts and contain no command-name exceptions;
- the plugin contains no Bash command semantics.

One independent command grammar should normally have one profile module. A genuinely shared, data-driven family may share a module when the members have the same operand model and decision facts. File size alone is not the rule; semantic ownership is.

## Adding or changing a profile

Read `ARCHITECTURE.md` first. Then decide whether the request fits the existing extension contract.

For an ordinary extension:

1. Locate or create the command's module under `src/policy/profiles/`.
2. Recognize the complete invocation, including every supported option and operand position.
3. Return unsupported for unknown or ambiguous adjacent forms.
4. Emit all visible path effects and baseline dependencies required by the existing fact model; shared classification derives mutation scopes from non-read effects.
5. Register only dispatch in `profiles/registry.ts`; do not put grammar there.
6. Add positive and negative cases to that profile's own test file under `test/profiles/`.
7. Run the complete architecture and integration test suite.

A profile rejection must be terminal for that invocation. Never let a partly recognized form fall through to a more permissive generic recognizer.

If the request needs a new decision-unit kind, fact kind, situation, red-line interpretation, aggregation exception, embedded-language parser, or state/control-flow simulation, stop. Leave the form asking and propose an architecture decision record; do not hide the change in a profile.

## Profile code as specification

Profile modules should be small enough that a maintainer can answer four questions directly from the code:

1. Which invocation shapes are recognized?
2. Which options and operands are accepted?
3. Which shared facts are emitted?
4. Which adjacent or dynamic forms remain unsupported?

Prefer explicit finite sets and small parsing functions over heuristic danger scans. Comments should explain a non-obvious trust boundary or rejected grammar, not restate code. Exact examples belong in tests.

Current modules may be grouped only where the grammar is genuinely shared. If a module begins accumulating unrelated option languages or tool-specific exceptions, split it before adding more behavior.

## Test organization

Tests mirror architecture ownership:

```text
test/policy/architecture.test.ts   stable parser/normalization/aggregation contract
test/policy/workspace.test.ts      situation and workspace-red-line contract
test/policy/cwd.test.ts            cwd normalization boundary
test/policy/redirect.test.ts       redirect decision units
test/profiles/<profile>.test.ts    one command/profile grammar
test/policy-engine.test.ts         gate-facing policy behavior
test/plugin.test.ts                OpenCode 2.x hooks, correlation, dialect gate
```

Profile tests should include:

- representative allowed forms;
- unknown options and malformed operands;
- dynamic values where literals are required;
- internal and external paths when the profile emits path effects;
- dirty, absent, and ambiguous baselines when approval depends on files;
- nearby forms that could accidentally fall through.

Architecture tests should not become an inventory of commands. They protect structural completeness, the three situations, red lines, all-unit aggregation, stability conflicts, and unsupported semantic boundaries. A profile addition should normally require no change to architecture tests.

Run:

```bash
npm run typecheck
npm test
git diff --check
```

## OpenCode integration

`shell` and `external_directory` are distinct permission requests but share one Bash policy entry point. `edit` remains a separate path policy. Adapter code may observe hook events, correlate them, invoke policy, audit, and set the in-band effect. It must not add command-specific approval behavior.

The adapter is specified by [ADR-0006](docs/architecture-decisions/0006-opencode-v2-in-band-integration.md). Integration assumptions currently verified against OpenCode 2.0.18 (`.reference/opencode-v2`, tag `v2.0.18`):

- **Plugin shape.** The plugin is a default export `{ id, setup(ctx) }` (the Promise API of `@opencode/plugin`). `@opencode/plugin` is a type-only devDependency, so the plugin carries no runtime dependency on the SDK. Workspace is `ctx.location.project.directory` (the location directory when the project is the filesystem root); the session default cwd is `ctx.location.directory`.
- **In-band verdict.** `permission.evaluate` runs after configured `deny` rules have already short-circuited, with a mutable `effect`. The adapter changes only `ask` to `allow`. A rejected hook promise becomes an engine defect that fails the tool call, so every callback swallows its own exceptions.
- **Default rules.** The default agent rules are allow-all for `shell` and `edit`. Only a per-agent `ask` baseline (README "Installation") makes those requests reach the hook as `ask`. Arriving allows are audited as `engine-allowed`, and `shell`/`edit` warn once per agent.
- **Correlation.** Requests carry no command text and no tool name. `source.id` equals the tool-call ID seen by `tool` `execute.before`/`execute.after`. The consumed tools (`shell`, `read`, `glob`, `grep`, `edit`, `write`, `patch`) are all `codemode: false`, so one call ID is one invocation.
- **Resource formats.**
  - `shell` resources are trimmed slices of the command, from either scanner; the adapter binds them by substring.
  - `external_directory` resources are `DIR/*` for the resolved target (the file's directory, or the directory itself), with no metadata except `patch`'s `{ filepath, parentDir }`.
  - `edit` resources are literal paths, relative to the location directory when internal and absolute when external.
- **Interpreter.** The shell interpreter comes from config `shell`, else `$SHELL`, else the platform fallback (`/bin/zsh` on darwin). `shell` `create.before` fires immediately before the same call's permission requests, with the final `invocation.shell`. The dialect gate matches observations to calls by exact command text.
- **Advisory hooks.** Guidance uses `session` `context`, which fires only for primary requests. Alerts clear on `permission.replied` from `ctx.event.subscribe` (envelope `{ type, data }`).
- **Precedence.** Saved "always" grants (per project) and session permissions are merged after agent rules and bypass Sentinel.
- **Reloading.** Local plugin sources are watched and reloaded on change. A reload starts with an empty correlation map, so in-flight calls ask.

Re-verify these assumptions whenever the supported engine range changes. The quickest end-to-end check is `opencode run --standalone` with `OPENCODE_CONFIG_DIR` pointing at a throwaway config that loads this checkout with `audit` enabled:

- an approvable command runs;
- an external write asks;
- a zsh `shell` setting yields `dialect: zsh`;
- a scratch `write` passes both of its asks;
- removing the per-agent baseline yields `engine-allowed`.

## Parser provenance

The pure-TypeScript Bash parser was adapted from Moonshot AI's Kimi Code CLI at commit `f88ed6d45bcf5ea358c173af7a3568b57ba9bd38`. Preserve the attribution in [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md) when updating parser sources.

Kimi's former dangerous-command analyzer is not a policy authority for this project and must not be reintroduced or composed with the three-situation model. Parser updates and policy changes are separate reviews.

## Documentation rule

Update README only when user-visible purpose, setup, high-level behavior, or a trust boundary changes. Update ARCHITECTURE only after an approved architecture decision. Ordinary command and option support should be self-documenting in its profile module and tests; it does not require synchronized prose edits to these overview documents.
