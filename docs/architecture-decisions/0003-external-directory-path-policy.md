# ADR-0003: A read path policy for path-originated external_directory asks

- Status: accepted
- Date: 2026-09-11
- Supersedes: none

## Problem

OpenCode's `external_directory` permission fires for any tool that touches a
path outside the working directory, whatever the tool. Sentinel's adapter
(`plugin.ts` `handleExternal`) only recognizes asks that carry a Bash command
(`metadata.command`), i.e. those originating from the `bash` tool. Every
path-originated ask — from the `read`, `glob`, and `grep` tools — carries a
path or pattern instead, so the adapter returns without replying and the native
dialog always prompts.

The observable inconsistency, from a real session: reading
`~/.config/opencode/opencode.jsonc` with the `read` tool prompts every time,
while the exactly equivalent Bash command `cat ~/.config/opencode/opencode.jsonc`
auto-approves. The same holds for `glob` (vs `ls`) and the built-in `grep` tool
(vs `rg`/`grep`). `edit`-family tool calls also fire an accompanying
`external_directory` ask that is currently unhandled; that direction is benign
(see "Write origins" below) but unverified for double-prompting.

This gap undermines the product goal: routine, read-only, non-sensitive external
access through path tools prompts 100% of the time.

## Why an extension is insufficient

Command profiles recognize complete Bash invocations inside the decision-unit
pipeline. A path-originated `external_directory` ask contains no Bash source at
all; there is nothing for a recognizer to parse and no decision unit to build.
The gap is in the permission-gate mapping of ARCHITECTURE §6, which currently
defines exactly two shapes for the `external_directory` gate ("same complete
Bash policy" for command-carried asks, and — implicitly — nothing for anything
else). Extending which ask shapes a gate consumes is a gate-boundary change, not
a profile widening, so per §8 it takes a record.

## Affected contract

- §6 permission-gate boundary: `external_directory` gains a second consumed
  shape. Command-carried asks keep the complete Bash policy, unchanged. A
  path-shaped ask whose origin is positively identified as a read-only tool
  (`read`, `glob`, `grep`) is evaluated by a new pure path rule mirroring the
  situation-2 external-read semantics:
  - path resolves inside the workspace → allow;
  - path resolves outside and matches an ADR-0002 sensitive root → ask;
  - otherwise → allow.
- Trust boundaries: reuses the existing lexical resolution and the sensitive
  catalogue as-is. No new matching rules; symlink and case behavior inherit the
  documented limits of those mechanisms.
- Product invariants: unchanged. Allow still requires positive recognition
  (a concrete, resolved path from an identified read-only origin); everything
  unrecognized asks.
- Decision units, fact kinds, situations, red lines, structural completeness,
  and aggregation: unchanged. This path never enters the Bash pipeline.

## Alternatives

1. **Leave path-originated asks unhandled** (status quo): every external touch
   by `read`/`glob`/`grep` prompts. Rejected — it is the problem.
2. **Pure configuration**: users add `external_directory` allow rules to
   `opencode.json`. Rejected as the project answer — those are all-or-nothing
   prefix grants with no sensitive-path awareness, no fail-closed shape
   analysis, and they live outside the reviewed policy.
3. **Apply the path policy to every path-shaped ask**, regardless of origin.
   Rejected — it would auto-approve the directory-access half of an external
   `edit`/`write`/`patch` operation, contradicting "external writes ask" at a
   gate this project controls.
4. **Read-origin-only path policy** (this ADR).

## Decision

`handleExternal` branches on ask shape:

1. `metadata.command` present → the existing complete Bash policy. No change.
2. Otherwise, extract a candidate path (`metadata.filepath`, else a single
   `patterns[0]` that contains no glob metacharacters) and an origin
   identification. Only if the payload positively identifies a read-only origin
   tool does the path rule run; reply `once` on allow, and on ask leave the
   native dialog, exactly like every other gate.
3. Everything else — no path, glob characters, unresolvable path, unknown or
   non-read origin (`edit`, `write`, `patch`, anything else) — escalates
   (no reply).

Write origins (`edit`/`write`/`patch`) deliberately keep the native dialog for
their `external_directory` ask. Approving directory access for an external
write is not Sentinel's call to make, even though the separate `edit` gate
still guards the modification itself; the gates remain independent per §6.

Replies on this path reuse the existing audit line (`gate:
"external_directory"`) and alert hooks, so escalation visibility is uniform
across gates.

### Implementation precondition: payload verification

The exact payload of path-originated asks (whether `metadata.filepath`,
`patterns`, and an origin/tool field exist, and their precise spellings) is not
yet verified against the supported engine (1.18.29). Implementation starts with
a one-time shape probe: when `audit` is enabled, log the raw properties of
otherwise-unhandled `external_directory` asks, and confirm the fields from a
real session. If the payload cannot positively identify the origin tool, this
ADR is reduced in scope to whatever shapes are provably read-only, or withdrawn
with the status quo's fail-closed behavior standing.

Verification outcome (2026-09-11, before implementation): inspection of the
1.18.29 binary shows `Tool.assertExternalDirectory` (legacy path, callers:
`read`, `glob`, `list`) emits `metadata: {filepath, parentDir}` with
`patterns: [parentDir + "/*"]`, while the v2 `LocationMutation` family
(`edit`/`write`/`patch`) emits `metadata: {}`. The positive identification is
therefore "concrete `metadata.filepath` without glob metacharacters"; both
misclassification directions fail closed (a v2 read-only tool with empty
metadata asks; a hypothetical legacy write tool's directory ask would still be
gated by the independent `edit` permission). The shapes are recorded in
DEVELOPMENT.md's integration assumptions and must be re-verified on engine
bumps.

## Complexity bound

One pure predicate over an extracted literal path:
`resolvePath` → `withinWorkspace` / `isSensitiveTarget`, the same three calls
the Bash pipeline already makes per read effect. No new state, no shell or
filesystem simulation, no new fact or unit kinds, no aggregator contact. The
origin allowlist (`read`, `glob`, `grep`) is a finite catalogue like
`RISKY_ENVIRONMENT_NAMES`; extending it later is an ordinary edit.

## Fail-closed behavior

- Missing path, glob metacharacters, `~otheruser`, empty or dynamic values:
  unresolvable → ask.
- Origin not positively identified as a read-only tool → ask.
- Sensitive external path (ADR-0002 roots, additive user roots) → ask.
- Any exception in the new branch → ask (the adapter's existing swallow-and-
  escalate behavior).
- OpenCode `deny` rules and session "always allow" grants keep their documented
  precedence; `.env` protection via OpenCode's own read defaults is untouched
  and deny wins over this policy.

## Cross-model consistency

The three situations, their precedence, red lines, unit composition, and
aggregation are untouched: no Bash source is analyzed on this path, so no unit
or fact is created. Lexical matching and the sensitive catalogue behave
identically to the Bash external-read rule, so `read` and `cat` now agree by
construction instead of diverging. Gate independence is preserved: approving a
`read`-originated `external_directory` ask approves nothing else, and an
`edit`-originated one still escalates everywhere.

Honest limits, to be documented rather than papered over:

- The sensitive catalogue remains best-effort; an unlisted sensitive path read
  by the `read` tool auto-allows exactly as it would via `cat`.
- Matching stays lexical; symlinks are not canonicalized.
- `glob`/`grep` asks that arrive as patterns rather than concrete paths mostly
  stay unhandled (pattern semantics cannot be reduced to a finite path set
  safely), so the practical win is concentrated on the `read` tool.

## Counterexamples and tests

Allow (new behavior):

- `read` of `~/.config/opencode/opencode.jsonc` (external, non-sensitive).
- `read` of a workspace-relative path.
- `read` of `/etc/hosts`.

Ask (unchanged or newly explicit):

- `read` of `~/.ssh/id_ed25519`, `~/.aws/credentials` (sensitive roots).
- Any ask with a glob pattern (`**`, `src/**`), `~user`, or no path.
- Any ask whose origin is `edit`/`write`/`patch` or unidentified.
- Traversal `~/foo/../../.ssh/x` normalizes under a sensitive root → ask.

Architecture-contract regressions to pin in tests:

- Command-carried `external_directory` asks still run the complete Bash policy
  (`cat /etc/hosts` allow, `rm /tmp/x` escalate) — the two shapes must not
  interfere.
- The `edit` gate's external escalation is unchanged.

## Migration and compatibility

Purely prompt-reducing for identified read-only origins; every other shape
keeps today's behavior. No configuration or data migration. Users who prefer
the old always-prompt behavior get it by not upgrading, or by OpenCode-side
permission rules, which keep precedence.

## Documentation updates

- `ARCHITECTURE.md` §6: `external_directory` consumes two shapes — the Bash
  policy for command-carried asks and the read path policy for identified
  read-only path asks.
- `README.md`: "OpenCode behavior" section notes that external `read`/`glob`/
  `grep` asks follow the same outside-workspace read rule as Bash.
- `DEVELOPMENT.md`: integration assumptions record the verified payload fields
  and the shape probe.
- Tests: adapter-level plugin tests for both shapes plus the adversarial cases
  above.

## Approval

Accepted explicitly by the maintainer on 2026-09-11.
