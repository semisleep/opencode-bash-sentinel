# ADR-0004: Auto-approve external mutations under designated scratch roots

- Status: accepted
- Date: 2026-09-11
- Supersedes: none

## Problem

Situation 2 auto-approves recognized external reads but asks for every
external mutation. The frequent, benign pattern that this blocks is the agent
scratch file: writing, editing, moving, or cleaning up tool output and probe
scripts under the system temp directory — `strings /bin/ls > /tmp/out.txt`,
`cp /etc/hosts /tmp/snapshot`, `sed -i 's/a/b/' /tmp/draft`,
`rm -rf /tmp/build-probe`. The audit log shows this shape escalating
repeatedly in ordinary sessions. Each occurrence costs a prompt for an
operation whose target is, by convention of the directory itself, ephemeral.

The current rule cannot distinguish "write into ephemeral system scratch"
from "write anywhere external" because situation 2 has no notion of trusted
external mutation targets.

## Why an extension is insufficient

The external-mutation rule lives in the shared classifier
(`analyze.ts` `finalize`, situation-2 branch), not in any command profile.
Redirects, `cp`, `mv`, `rm`, and in-place editors all funnel through the same
`effects.every(kind === "read")` check. No profile can widen that check, and
per §7 an extension must not add classifier exceptions. Introducing a class
of trusted external mutation targets is a new trust boundary (§2) and a rule
change inside a situation (§8), the mirror image of ADR-0002: where ADR-0002
added a denylist that narrows allow→ask for reads, this adds a bounded
allowlist that widens ask→allow for mutations. Widening requires its own
record and its own fail-closed valves.

## Affected contract

- Situation 2 rule: gains a scratch-root allowance. Recognized external reads
  still allow (subject to the sensitive-read red line); recognized external
  mutations now allow **only** when every mutation effect targets a strict
  descendant of a designated scratch root. Everything else still asks.
- New red line (scratch-root deletion): a delete or move-source effect whose
  target is a scratch root itself asks, symmetric to the workspace-root
  deletion red line in situation 1.
- Trust boundary: adds "designated scratch roots are trusted for lexical
  mutation" to §2, alongside — and subordinate to — the sensitive-root
  boundary: a sensitive-read match always asks regardless of scratch.
- Product invariants: positive recognition and fail-closed are preserved —
  the allowance consumes already-resolved effect targets of already-recognized
  units; it never creates recognition, execution trust, or "no known danger
  found, therefore allow."
- Decision units, fact kinds, situation derivation, and aggregation:
  unchanged. No new fact kind; mutation scopes for scratch writes already
  exist and already participate in the stability-overlap check.

## Alternatives

1. **Leave unsupported** (status quo): all external mutations ask. Rejected —
   the scratch-file pattern is frequent and genuinely harmless in intent;
   asking every time erodes the 70–80% prompt-reduction goal without catching
   a real accident class.
2. **Auto-approve all external mutations.** Rejected — unbounded; loses the
   checkpoint for writes to configuration, home, and system paths.
3. **Workspace-local scratch convention only** (tell agents to write under
   the workspace). Rejected as the sole remedy — real workflows need system
   temp (tool interop, cross-session state), and workspace pollution is its
   own cost. Remains recommended where applicable.
4. **This ADR**: a finite, host-supplied scratch-root list with two internal
   red lines (sensitive reads win; scratch-root deletion asks).

## Decision

Introduce a scratch-root predicate, evaluated in the situation-2 branch of
`finalize`, ordered after the sensitive-read red line:

1. A read effect under a sensitive root asks (unchanged, and it wins: the
   scratch allowance is never consulted for it).
2. Every **mutation** effect (write, delete, move-source, move-destination)
   must resolve as a **strict descendant** of a designated scratch root
   (path equals `root + path.sep + …`; equality with a root is not a
   descendant). Reads have no scratch requirement — non-sensitive external
   reads keep today's behavior wherever they point.
3. A delete or move-source effect targeting a scratch root itself asks
   (implied by strict descent, stated as a named red line).
4. A unit with any mutation effect outside scratch asks as a whole; mixed
   operations are not split, preserving §4.

Consequences made explicit:

- `cp /etc/hosts /tmp/out` allows (read non-sensitive, write scratch).
- `cp ~/.ssh/id_rsa /tmp/leak` asks (sensitive read wins).
- `mv /etc/passwd /tmp/x` and `mv /tmp/x /etc/passwd` ask (one mutation
  effect outside scratch).
- `mv /tmp/a /tmp/b` allows; `rm -rf /tmp/a` allows; `rm -rf /tmp` asks.
- Execution trust is untouched: `sh /tmp/x.sh` and workspace-entry scripts
  keep their existing profiles and red lines. Scratch covers effect kinds
  only, never execution or interpretation trust.
- The `.git` red line is deliberately **not** extended into scratch
  (maintainer decision). `rm -rf /tmp/other-session/.git` auto-approves.
  Accepted risk: destruction of throwaway checkouts that live in scratch but
  outside any workspace; a workspace placed under scratch keeps full
  situation-1 protection for its own `.git`.

Root list construction:

- The engine consumes a static `scratchRoots: readonly string[]` context
  fact; an empty list reproduces today's behavior exactly. The engine itself
  ships no defaults.
- **Default-on lives in the host wiring** (maintainer decision): `plugin.ts`
  supplies `/tmp` plus `/private/tmp` on darwin (lexical matching does not
  canonicalize the symlink; both spellings are needed) plus the
  host-process-resolved `TMPDIR` if it is set and absolute. `$TMPDIR` is
  never read at analysis time — environment semantics stay outside the
  trust model.
- `/var/tmp` and `/run/user/*` are deliberately excluded (persistent or
  session-scoped state, not ephemeral by convention); users may add them
  explicitly.
- Matching is lexical, exact-case, and trailing-separator-normalized,
  mirroring the allow-direction matchers `withinWorkspace`/`samePath` rather
  than `isSensitiveTarget`: case folding or raw trailing separators would
  widen toward allow (case folding approves `/TMP` as `/tmp` on a
  case-sensitive filesystem; a trailing slash would turn the root itself
  into a "descendant" and defeat the scratch-root deletion red line).

Plugin option `scratchPaths` (replacement semantics, maintainer-confirmed):

| Value | Effect |
| --- | --- |
| unset | host default list above |
| `false` | feature off; empty list; exactly today's behavior |
| `["/srv/scratch"]` | **replaces** the default list entirely; `/tmp` reverts to ask |

This is intentionally the opposite direction from `sensitivePaths` (additive
only): a widening list must be shrinkable by configuration, or no user can
ever be stricter than the default. Neither setting can remove the
sensitive-read red line or the scratch-root deletion red line.

## Complexity bound

One finite static list of absolute roots per `WorkspaceContext` plus one
prefix predicate (`isScratchDescendant`) with strict-descent semantics. Per
mutation effect the cost is a bounded prefix comparison. No new state, no
filesystem queries, no order or shell simulation, no new unit or fact kinds.
Growing, shrinking, or redefining the host default list later is
configuration, not architecture.

## Fail-closed behavior

- Empty or absent `scratchRoots`: exactly today's behavior (all external
  mutations ask).
- Unresolved or dynamic mutation target: already indeterminate, already asks.
- Mutation target that is a root itself, or outside every root: asks.
- Sensitive read in the same source as a scratch mutation: the read unit (or
  redirect unit) independently asks; worst-case aggregation escalates the
  line.
- Malformed or resource-exhausted input: earlier pipeline stages still ask
  before this rule is reached.
- A `scratchRoots` entry that coincides with, or nests under, a sensitive
  root: the sensitive red line is evaluated first and wins.

## Cross-model consistency

- Situation derivation is untouched: a target is still classified external
  first; the scratch allowance applies within situation 2, mirroring how the
  `.git` red line applies within situation 1.
- A workspace located under a scratch root is unaffected — targets inside it
  classify into situation 1 with all three of its red lines intact.
- Structural completeness, unit composition, and stability-conflict
  aggregation are unchanged; scratch writes emit the existing mutation facts
  and participate in the existing overlap check.
- The `edit` gate and the `external_directory` path-carried policy
  (ADR-0003) are untouched: this decision concerns command-carried mutation
  effects in the Bash policy only.

Honest limits, to be documented, not papered over:

- Matching is lexical; symlinks are not resolved. Scratch directories are
  typically world-writable and shared: any local process can pre-plant a
  symlink that redirects a scratch write elsewhere, or hold live state
  (sockets, lock files) under scratch. Sentinel is a prompt-reduction tool,
  not a sandbox (§1.1); the scratch allowance trusts path spelling, exactly
  like workspace containment.
- The `.git` non-extension (above) means cross-session destruction inside
  scratch is possible by design.
- Only the root path itself is deletion-protected; broad deletes of scratch
  *contents* allow by design — everything under a scratch root is treated as
  ephemeral.
- The sensitive catalogue remains best-effort (ADR-0002 limits unchanged).

## Counterexamples and tests

Positive (allow after this ADR):

- `strings /bin/ls > /tmp/s.txt`, `cp /etc/hosts /tmp/out`
- `sed -i 's/a/b/' /tmp/draft`, `rm -rf /tmp/build-probe`
- `mv /tmp/a /tmp/b`, `cat /etc/hosts > /tmp/leak` (non-sensitive read +
  scratch write)
- TMPDIR-rooted writes under the host-supplied resolved path.

New or preserved ask (must ask):

- `rm -rf /tmp`, `mv /tmp /tmp2` (scratch-root deletion red line)
- `mv /etc/passwd /tmp/x`, `mv /tmp/x /etc/passwd` (mixed mutation)
- `cp ~/.ssh/id_rsa /tmp/leak`, `cat ~/.ssh/id_rsa > /tmp/leak`
  (sensitive read wins over scratch)
- `rm -rf /var/tmp/x` (persistent directory not in defaults)
- `rm -rf /tmp/*` (glob operand stays dynamic and asks)
- `rm -rf /tmp/`, `rm -rf /tmp//` (trailing separators name the root itself)
- `rm -rf /TMP/x`, `strings /bin/ls > /Private/Tmp/x` (exact-case matching)
- `cp /etc/hosts /tmp/` (bare directory destination is the root, not a
  descendant; directory-destination expansion is not modeled)
- `sh /tmp/x.sh` (execution not covered by effect-kind allowance)
- `strings /bin/ls > /etc/out` (mutation outside scratch)

Architecture-contract regressions to pin:

- Situation precedence and all three situation-1 red lines unchanged.
- Empty `scratchRoots` reproduces today's verdicts byte-for-byte.
- Worst-case aggregation with a scratch mutation on one leg still escalates
  when the other leg asks.

## Migration and compatibility

Additive in the allow direction only for strict descendants of configured
scratch roots; every other external-mutation verdict is unchanged. Hosts and
standalone analyzer consumers that do not supply `scratchRoots` see no
behavior change. The `plugin.ts` default list lands in the same release as
the option, so default-on and the `false` opt-out ship together. No data
migration.

## Documentation updates

- `ARCHITECTURE.md` §2: add the scratch-root trust boundary, subordinate to
  sensitive roots. §4.2: amend "Only finite recognized external reads allow"
  to include the scratch-mutation allowance and the scratch-root deletion red
  line.
- `README.md`: outside-workspace section gains the scratch allowance, the
  opt-out, and the lexical/shared-directory caveats.
- `DEVELOPMENT.md`: record `src/policy/scratch.ts` ownership and tests.
- Tests: new `test/policy/scratch` contract coverage (positive, red-line,
  mixed, sensitive-precedence, empty-list regression) plus situation-2
  contract blocks; profile tests unchanged.
- `AGENTS.md`: no change.

## Approval

Accepted explicitly by the maintainer on 2026-09-11. All decision points
confirmed the same day: default-on host list; no `.git` red-line extension
into scratch; scratch-root deletion red line; `scratchPaths` replacement
semantics (unset → host defaults, `false` → off, array → replaces defaults).

Post-acceptance corrections (2026-09-11, same working session, before any
release), from adversarial review:

1. The original text specified case-insensitive matching after
   `isSensitiveTarget`. Corrected to exact-case with trailing-separator
   normalization: folding is safe only in the ask direction and would
   fail open on case-sensitive filesystems.
2. The host TMPDIR candidate is additionally rejected when it equals or
   lexically contains the home directory or the workspace root (for example
   `TMPDIR=$HOME`), a narrowing guard the original text did not require.
