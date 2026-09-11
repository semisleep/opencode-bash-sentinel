# ADR-0005: Effect-semantic path rules shared by every permission gate

- Status: accepted (decision points confirmed 2026-09-11; implementation
  pending the payload re-verification precondition below)
- Date: 2026-09-11
- Supersedes: none; generalizes ADR-0003 (read-side unification) and
  ADR-0004 (scratch roots), and subsumes the edit-gate gap those two left.

## Problem

ADR-0004 gave the Bash gate a scratch-root allowance for external mutations.
The `edit` gate kept asking for the same targets (`edit: outside workspace`),
because its handler had never heard of scratch roots. The root cause is not a
missing flag: the project organizes its path rules **by gate** instead of
**by effect semantics**, so every widening must be hand-copied into each
gate's handler, and copies drift.

Today the same semantics exist as three independent hand-written chains:

| Semantics | Bash chain | Gate chain |
| --- | --- | --- |
| external read rule (non-sensitive allow, sensitive ask) | `analyze.ts` `finalize` situation-2 branch | `handleExternal` read-origin branch (ADR-0003) |
| external mutation rule (scratch strict descendant allow, root/other ask) | `analyze.ts` `finalize` situation-2 branch | — (missing; this ADR) |
| in-workspace `.git` mutation red line | `analyze.ts` situation-1 loop (kind-aware) | `handleEdit` `.git` segment check (global, not workspace-scoped) |

Observable inconsistencies: `cat > /tmp/x` allows while `Write(/tmp/x)`
prompts (twice — the edit ask and the write-origin `external_directory`
ask); `rm -rf /tmp/s/.git` allows (ADR-0004 decision) while `Edit
/tmp/s/.git/config` asks.

## Principle (the decision)

**The path-domain rule table is defined once, keyed by effect kind and
resolved path class, and consumed by every gate.** Gates differ only in how
they process input — the Bash gate recognizes command syntax and extracts
facts; the edit and path-carried external gates receive a bare resolved
path. Same semantics, same rule, same verdict.

Scope limits, stated so the principle cannot be over-applied:

- **Rule-scope equivalence, not verdict equivalence.** The Bash gate keeps
  its positive-recognition layer: an unrecognized mutating command whose
  targets are perfect scratch paths still asks (fail-closed, §1.3–1.4).
  Path-only gates have no syntax to recognize; a resolved literal path is
  their recognition. Nothing in this ADR lets an allow come from not
  recognizing something.
- **Execution semantics are excluded.** Script trust, `source`, and the
  committed-and-unchanged baseline have no cross-gate counterpart and stay
  Bash-only.
- **The edit gate does not enter the three-situation model.** It consumes
  the shared rule table directly; no decision units or facts are created
  for it (ADR-0003's argument stands — there is no Bash source to analyze).
- **Bash-only mechanics stay Bash-only**: mixed operations are not split
  (§4.2), worst-case aggregation (§5), stability overlaps, `mv`'s
  source/destination pair — a single-path gate cannot express them and
  never needs to.

The existing fact taxonomy (§3: read / write / delete / move-source /
move-destination effects) already is the semantic classification; no new
fact kinds are introduced.

## Why an extension is insufficient

The duplicated rules live in the situation-2 classifier and in two gate
handlers. No command profile can reach any of them (§7 forbids classifier
exceptions; the edit and path-carried external branches contain no profile
layer at all). Re-homing rule ownership across the permission-gate boundary
(§6) and extending the scratch trust boundary (§2) beyond the Bash policy
are architecture changes per §8.

## Decision

### 1. Shared rule module

A single module (`src/policy/path-domain.ts`) owns the two external rules
and their reason strings:

- `sensitiveVerdict(path, ctx)` — ADR-0002 rule: a target under a
  designated sensitive root asks. Kind-blind, exactly as the Bash branch
  applies it today (it already catches sensitive mutations), evaluated
  **first** everywhere; a scratch root that overlaps a sensitive region
  asks on every gate.
- `scratchMutationVerdict(path, ctx)` — ADR-0004/0005 rule: strict scratch
  descendant allows; a scratch root itself asks (root-removal red line);
  everything else external asks.

Consumers: `analyze.ts` `finalize` (Bash situation 2), `handleEdit`,
`handleExternal` (read-origin and, new, write-origin branches). Bash's
kind-aware "scratch root removal" reason detail is preserved byte-for-byte
by keeping the kind test at its call site.

### 2. Edit gate (semantics: mutation)

```
withinWorkspace(p) ? (hasGitSegment(p) ? ask "edit: .git path" : approve)
                   : sensitiveVerdict(p).allow ? ask
                   : scratchMutationVerdict(p).allow ? approve
                   : ask "edit: outside workspace"
```

- Workspace containment is evaluated **first**, so a workspace nested under
  a scratch root keeps full situation-1 semantics on every gate.
- The `.git` segment check becomes **workspace-scoped** (maintainer
  decision, 2026-09-11: relax — aligning edit to ADR-0004's recorded
  decision that scratch `.git` is not red-lined). In-workspace `.git`
  still asks on both gates, mirroring the situation-1 red line, where Bash
  reads of `.git` still allow (kind-awareness is a Bash-only nuance; an
  edit is always a mutation).

### 3. Write-origin `external_directory` asks (semantics: mutation)

The accompanying directory-access ask of the edit family joins the same
table: when its payload positively resolves to a strict scratch descendant,
reply `once` (both halves of a scratch write now pass without a prompt,
matching `cat > /tmp/x`); sensitive, root, other-external, and
unidentifiable shapes keep the native dialog. ADR-0003's rejection of
write-origin approval rested on "external writes ask" being universal;
scratch descendants are the documented exception, so the rejection is
revisited **only** for that class.

**Implementation precondition — payload re-verification.** Write-origin
asks arrive engine-shaped (v2 family, empty metadata in opencode 1.18.29)
and the exact field spelling of the target path is unverified; the
currently failing `test/plugin.test.ts` drift-visibility case
(`/Users/dev/*.zshrc/*`, "no metadata") suggests shape drift already
happened. Implementation starts by resolving that test and re-verifying
the shapes against the supported engine, reusing ADR-0003's audit-probe
method. If the target path cannot be positively extracted, this half
stays fail-closed (native dialog) and the ADR is recorded as reduced in
scope — the edit-gate half stands on its own.

Verification outcome (2026-09-11, before implementation, from binary and
SDK-type inspection of 1.18.29 plus the session audit log): the legacy
`edit` tool fires only the legacy `edit` ask (`metadata.filepath`) and no
accompanying `external_directory` ask — the audit log records exactly one
edit-gate line per external write and zero path-carried external lines
across sessions, so the double-prompt concern is empirically absent. The
v2 `LocationMutation` family (`write`/`patch` and newer edit paths)
publishes a distinct event type, `permission.v2.asked` (an
`action`/`resources`/`save` payload with no `patterns` or legacy
`metadata`), which the plugin does not consume; those asks fail closed to
the native dialog today. Consequently **no write-origin external ask
exists on the consumed channel**: the write-origin column of the matrix
below is currently vacuous, and supporting v2 asks (new event type plus a
v2 reply API) is recorded as an engine-coupled follow-up, not part of
this ADR's implementation. The drift-visibility test failure was a
genuine audit-ordering race (two concurrent unawaited appends), fixed by
serializing audit writes per log path.

### Decision points (maintainer, 2026-09-11)

1. `.git`-in-scratch: **relax** — both gates allow; ADR-0004's decision
   stands, edit aligns to it. In-workspace `.git` unchanged (asks).
2. Write-origin `external_directory` asks: **join the shared table** as
   section 3.
3. Default-on via the shared host scratch list (unset → ADR-0004 defaults,
   `false` → off for **both** gates, array → replaces for both). Follows
   from synchronization: one list, one semantics, two consumers.

## Alternatives

1. **Per-gate patches forever** (the original 0005 draft: fix the edit gate
   only). Rejected — recreates the drift problem this ADR exists to close;
   the write-origin external ask would still prompt, making the fix
   user-invisible.
2. **OpenCode-native permission rules** for the temp dir. Rejected as the
   project answer (ADR-0003 already recorded why: all-or-nothing prefixes,
   no sensitive awareness, outside the reviewed policy and audit trail).
3. **Full verdict unification** (demand identical outcomes for identical
   paths across gates). Rejected — impossible and undesirable: Bash's
   recognition layer must keep asking for unrecognized forms.
4. **This ADR**: rule-table unification with explicit scope limits.

## Complexity bound

One new pure-module (~two predicates over an already-resolved string) and
three call-site rewirings. No new state, no filesystem queries, no order or
shell simulation, no new fact or unit kinds, no aggregator contact. List
configuration stays exactly ADR-0004's single `scratchPaths` option.

## Fail-closed behavior

- Empty or absent `scratchRoots` (including `scratchPaths: false`): every
  gate reproduces today's verdicts byte-for-byte.
- Unresolved, glob-shaped, or metadata-less edit/external asks: native
  dialog unchanged (the write-origin branch additionally requires positive
  path extraction).
- Scratch root itself, case-variant spellings, `..` escapes out of scratch:
  not strict descendants → ask on every gate.
- Sensitive overlap: asks first on every gate, including edit.
- Any exception in a gate branch: existing swallow-and-escalate behavior.

## Cross-model consistency

- The three situations, their precedence, unit composition, recognition,
  and aggregation are untouched; the Bash situation-2 branch changes call
  sites, not outcomes.
- §6's meaning is refined, not abandoned: gates stay independent in
  **input processing** (approving a Bash command approves no edit; each
  ask is answered on its own), while **rule provenance** is single-source.
- Honest limits inherited unchanged: lexical matching, no symlink
  canonicalization, best-effort sensitive catalogue, shared world-writable
  scratch directories, engine-coupled ask shapes for the external gate.

## Counterexamples and tests

The verdict matrix that pins "same semantics → same verdict" (the durable
enforcement of this ADR — a cross-gate consistency contract test):

| Resolved path | Bash read | Bash mutate | read-origin ext. ask | edit gate | write-origin ext. ask |
| --- | --- | --- | --- | --- | --- |
| in-workspace file | allow | allow | allow | allow | n/a |
| in-workspace `.git` file | allow | ask | allow | ask | n/a |
| scratch strict descendant | allow | allow | allow | **allow** (new) | **allow** (new) |
| scratch `.git` file | allow | allow | allow | **allow** (new, relaxed) | **allow** (new) |
| scratch root itself | allow | ask | allow | ask | ask |
| sensitive root | ask | ask | ask | ask | ask |
| `/etc` non-sensitive file | allow | ask | allow | ask | ask |
| `$HOME` ordinary file | allow | ask | allow | ask | ask |

Additional pins: empty-list regression reproduces today on all gates;
worst-case aggregation with scratch legs unchanged; edit-family audit
reasons distinguish the new approvals from `edit: outside workspace`.

## Migration and compatibility

Additive toward allow only, and only for strict scratch descendants
(including their `.git` paths). Every other verdict on every gate is
unchanged. `scratchPaths: false` restores pre-ADR-0005 behavior on both
gates simultaneously. No data migration.

## Documentation updates

- `ARCHITECTURE.md` §2: scratch-root and sensitive rules become
  gate-shared trust facts. §6: rewrite as "independent input processing,
  single-source effect-semantic rules"; record the edit and write-origin
  external branches.
- `README.md`: edit-permission and outside-workspace sections document the
  matrix, the shared opt-out, and the caveats.
- `DEVELOPMENT.md`: `src/policy/path-domain.ts` ownership; engine-shape
  re-verification duty now covers write-origin asks too.
- Tests: new cross-gate consistency contract block; extend
  `test/policy/scratch.test.ts` and the `test/plugin.test.ts` edit and
  external blocks.

## Approval

Accepted 2026-09-11. Maintainer confirmed: (1) relax `.git`-in-scratch on
the edit side, keeping ADR-0004's Bash decision; (2) fold write-origin
`external_directory` asks into the shared rule table, subject to the
payload re-verification precondition; (3) the effect-semantic
synchronization principle itself, including the shared-list default-on
consequence. Implementation proceeds after the precondition's shape
verification lands.
