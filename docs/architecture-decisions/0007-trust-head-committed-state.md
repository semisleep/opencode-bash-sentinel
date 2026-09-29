# ADR-0007: Trust HEAD-committed state; retire the pinned Git baseline

- Status: accepted (2026-09-29; ratified by the maintainer in conversation)
- Date: 2026-09-29
- Supersedes: ADR-0001 (its decision and rationale; its fail-closed semantics carry
  over)
- Amends: the §2 trust-model sentence on committed baselines; ADR-0006 §1's note on
  context creation

## Problem

ADR-0001 captured `HEAD` once per policy context and required baseline-dependent
files to match that frozen commit. Three findings, in increasing order of weight,
make that mechanism wrong for this product today:

1. **The threat model was adversarial-shaped, but the product is not.** §1
   invariant 1: Sentinel is a prompt-reduction tool, not a Bash sandbox. ADR-0001's
   motivating scenario — an agent that edits, adds, and commits a file "and
   immediately turn[s] that new commit into an automatically trusted baseline" —
   describes a deliberate adversary. The gate's actual job is to double-confirm
   *intent divergence* (accidental or task-driven); a deliberate agent is out of
   scope, with unbounded routes the analyzer explicitly does not model.

2. **Even on security terms, the pin guards one door of many.** The baseline
   checks only direct control files (`package.json`, the invoked script). Every
   transitive file — a script referenced by a declared npm script, an imported
   module, a build config — is modifiable without any baseline consult; §2 already
   accepts "not hooks, transitive commands, build graphs" as outside trust
   (maintainer observation, 2026-09-29: modifying the *content* of an
   already-declared script bypasses the pin entirely). The perimeter never covered
   the attack surface it was drawn for.

3. **Under the v2 host model (ADR-0006), the cost inverted.** ADR-0001 assumed the
   v1 process model: one policy context per interactive run, cheap restart (its
   own consequences line says "restarting the plugin creates a new context"). In
   v2 the context lives in a Location inside a daemon that runs for days, and the
   pin advances only on a rebirth no human initiated: 60-minute idle eviction
   (`location-activity.ts`, enabled in the server graph), plugin module
   hot-reload, a 24-hour supervisor timer, or daemon restart. Consequence, measured
   on 2026-09-29: after every human commit, every npm/npx/script-trust decision
   asks with the false reason `requires clean committed files` until an incidental
   rebirth; a full diagnostic session was required to trace it. In the incident
   window the pin produced ~15 spurious prompts and caught zero accidents —
   directly contrary to invariant 1 (prompt reduction). The residual protection
   ("re-ask on agent-committed changes within the current activity episode") is
   porous by construction: those changes become trusted at the next rebirth
   anyway.

## Why an extension is insufficient

The pinned baseline is a §2 trust boundary: "later commits do not advance that
baseline." No recognizer or profile can change what "clean" means; the semantics
live in `BaselineInspector` and are consumed by the npm/npx/script/make/pip gates
together. Changing them is exactly the architecture-change process, not a
quiet profile widening.

## Affected contract

- §2 trust model: the sentence "a workspace entry script is trusted only when its
  content matches the Git commit captured when the Sentinel context is created and
  remains unchanged in the index and worktree; later commits do not advance that
  baseline" is replaced by: "a workspace entry script or workflow control file is
  trusted only when it is committed at the current `HEAD` and unchanged in the
  index and worktree; trust follows the current commit."
- ADR-0001: superseded in decision and rationale; its `unknown`/`absent` fail-closed
  semantics carry over unchanged.
- ADR-0006 §1: the policy context is still created once per plugin setup; only the
  pinning behavior disappears from it.
- Unchanged: §1 product invariants, decision units, fact kinds, the three
  situations, red lines other than the trust sentence, structural completeness,
  and aggregation.

## Alternatives

1. **Keep the pin; add staleness alerts and guidance.** Treats the symptom; the
   prompts and the daemon-lifecycle coupling remain. Rejected by the maintainer.
2. **Commit-origin witness ("bless cookie"): a `post-commit` hook records
   human-side commits by process ancestry; the baseline advances only blessed
   refs.** Defends exactly the adversarial boundary this product disclaims; adds a
   new trust boundary (hook-witnessed origin) and a per-workstation hook
   deployment. Rejected as over-engineering for a prompt-reduction tool.
3. **Re-pin per session or per startup.** v2 sessions are agent-spawnable
   (subagents, `opencode run`); frontends are invisible to the daemon's plugin.
   Collapses to agent-triggerable re-trust. Rejected.
4. **ADR-0001 alternative 2: make `git commit` itself ask.** Converts a routine
   legitimate operation into prompts, contrary to invariant 1. Still rejected; in
   the accident model the commit is the human's visible, auditable review surface.

## Decision

No commit id is captured, stored, or pinned. `BaselineInspector` semantics become:

- `status(file)`:
  - `clean` — the path is tracked and the index and worktree match the current
    `HEAD` for that path (no staged, unstaged, or untracked difference);
  - `dirty` — present in `HEAD` but the index or worktree differs;
  - `absent` — the path is not present in the current `HEAD` (untracked and
    staged-new files included);
  - `unknown` — not a git repository, no `HEAD`, or git failure.
- `committedText(file)` reads the current `HEAD` (`git show HEAD:<path>`).
- `HEAD` is resolved per decision; trust follows the current commit. There is no
  per-context pin and therefore no staleness class.
- The change applies uniformly to every consumer: npm/npx control files
  (`node.ts`, `npx.ts` via `helpers.ts dependencies`), workspace entry scripts
  (`script.ts`), make/pip control files (`make.ts`, `pip.ts`). One semantic
  everywhere (maintainer decision 2026-09-29).

Consequences matrix:

| scenario | pinned baseline (old) | HEAD-committed (new) |
| --- | --- | --- |
| `npx` name not declared at `HEAD` | ask | **ask** (preserved) |
| control file edited, uncommitted | ask | **ask** (preserved) |
| freshly written untracked script | ask | **ask** (preserved; matches the anti-ad-hoc-script guidance) |
| staged-but-uncommitted change | ask | **ask** (preserved) |
| human commit lands mid-episode | ask until rebirth (the incident) | **allow** (fixed) |
| agent commits a control-file change this episode | ask until rebirth (porous) | allow (accepted: deliberate acts are out of scope; commits are the visible, auditable review surface) |
| non-git workspace / git failure | unknown → ask | unknown → ask (unchanged) |

The audit `build` stamp describes plugin *code* provenance, not trust, and is
unchanged by this ADR.

## Complexity bound

Net negative. Removes the pinned ref and the per-context immutability rule; adds
one semantic with an explicit bound: `HEAD` is resolved at decision time (at most
one `rev-parse` per baseline-dependent decision, alongside the existing per-file
git invocations).

## Fail-closed behavior

- Not a git repository, no `HEAD`, or any git failure → `unknown` → ask.
- Untracked or staged-new files → `absent` → not trusted → ask.
- Modified-in-index-or-worktree → `dirty` → ask.
- No new "allow" path derives from absence of information; an allow still requires
  positive verification that the path is tracked and matches `HEAD`.

## Cross-model consistency

Situations, red lines beyond the trust sentence, unit composition, stability
conflicts, and aggregation are untouched: this changes the *source* of one fact
(baseline cleanliness), not how facts combine into verdicts. All gates that
consult the baseline change verdicts identically, because they share
`BaselineInspector`.

## Counterexamples and tests

**Positive cases**

- `npx tsx …` with `tsx` declared at current `HEAD`, clean worktree → allow.
- A commit landing mid-episode makes the next `npx`/`npm run`/script decision
  allow **without** restart or reload (regression for the 2026-09-29 incident).
- A committed workspace script → allow.

**Adjacent rejected cases**

- Control file with staged or unstaged modifications → ask.
- Freshly written untracked script → ask.
- `npx` name absent from `HEAD`'s package.json → ask.

**Adversarial / degenerate cases**

- Non-git workspace, detached state, or git failure → `unknown` → ask.
- File deleted in the worktree but present at `HEAD` → `dirty` → ask.

**Architecture-contract regressions**

- Every baseline consumer (`script.ts`, `node.ts`, `npx.ts`, `make.ts`, `pip.ts`)
  changes verdicts together — no gate keeps private pin semantics.

## Migration and compatibility

- After a commit, baseline-dependent decisions trust the new state immediately;
  the post-commit ask storm and the rebirth rituals (touch-a-source-file, daemon
  restart) become unnecessary.
- Users who relied on the pin to block *their own* uncommitted experiments keep
  that behavior (uncommitted still asks); only committed state becomes trusted
  promptly.

## Documentation updates

- `ARCHITECTURE.md` §2: apply the sentence replacement above.
- `DEVELOPMENT.md` "Reloading" note: drop the re-pin ritual sentences; a commit no
  longer needs a reload to be trusted.
- `README.md`: update the trust-model summary (ADR-0001's doc list requires the
  same surfaces; AGENTS.md's no-README rule applies to profile changes, not ADR
  execution).
- `AGENTS.md`: no change.
- Tests: the cases above; retire the "modified and committed after context
  creation still asks" regression from ADR-0001, replaced by its inverse.

## Approval

- 2026-09-29, maintainer (conversation): direction approved — "同意，不再记录
  commit ID 了"; text ratified and status set to `accepted` the same day
  ("adr批准了，开始改吧"). Implementation follows this record.
