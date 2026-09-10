# ADR-0001: Fix the Git trust baseline for a policy context

- Status: accepted
- Date: 2026-09-10
- Supersedes: none

## Problem

Workspace scripts and development workflows rely on committed control files. Comparing only with the current `HEAD` lets an agent edit, add, and commit a file during the session and immediately turn that new commit into an automatically trusted baseline. That does not satisfy the intended “not changed in this round” boundary.

## Why an extension is insufficient

The trusted revision is shared by script and workflow profiles and defines what `stabilityDependencies` mean. It cannot be corrected inside one command recognizer without changing the common trust model.

## Affected contract

This changes the Git baseline trust boundary. Decision units, situations, red lines, and aggregation remain unchanged.

## Alternatives

1. Keep following current `HEAD`, accepting that an agent-created commit establishes trust.
2. Stop automatically approving `git commit`.
3. Capture `HEAD` when the policy context starts and keep it fixed for that context.

## Decision

Capture the resolved `HEAD` commit when `WorkspaceContext` is created. A baseline-dependent file must exist in that commit and the current index/worktree content must still match it. Moving `HEAD` later does not advance trust until a new policy context is created.

## Complexity bound

The model adds one immutable commit identifier per workspace context. It adds no command-order simulation, history traversal, or mutable per-command state.

## Fail-closed behavior

If the initial commit cannot be resolved, a baseline-dependent file is unknown and its command asks. Missing files are absent. Any difference from the captured commit asks.

## Cross-model consistency

The three situations and their precedence do not change. Script entry paths still select situation 1; workflow profiles remain situation 3. Both produce the same stability dependencies as before. Aggregation remains order-independent and Git-agnostic.

## Counterexamples and tests

Tests must cover a file that is clean initially, becomes modified and committed after context creation, and still asks. A newly created context after an explicitly trusted restart may use the new `HEAD`.

## Migration and compatibility

Long-running OpenCode sessions no longer trust newly committed scripts or workflow definitions automatically. Restarting the plugin creates a new context and baseline.

## Documentation updates

Update the trust boundary in `ARCHITECTURE.md`, summarize it in `README.md`, reflect module ownership in `DEVELOPMENT.md`, and add baseline regression tests. `AGENTS.md` needs no change.

## Approval

Accepted explicitly by the maintainer on 2026-09-10.
