# ADR-0002: A situation-2 red line for sensitive external reads

- Status: accepted
- Date: 2026-09-10
- Supersedes: none

## Problem

Situation 2 currently auto-approves every recognized read whose targets are all
outside the workspace (`cat`, `head`, `tail`, `cut`, `strings`, `dd if=`, a `<`
redirect, and so on). The documented illustrative case is benign
(`cat /etc/hosts`), but the same rule silently approves reads of well-known
credential material — `~/.ssh/id_ed25519`, `~/.aws/credentials`, `~/.netrc`,
`~/.gnupg`, cloud CLI tokens — with no human prompt.

Under this project's threat model the concern is not a malicious model but an
agent that malfunctions or blunders: an agent debugging an unrelated problem can
`cat ~/.aws/credentials` or grep `~/.ssh/`, spilling secrets into the transcript,
provider context, and logs. This is a classic accidental-disclosure footgun that
a single approval prompt would catch, and it is exactly the class of accident the
tool exists to reduce.

## Why an extension is insufficient

The check must fire uniformly for a *read effect whose resolved path is
sensitive*, regardless of which command produced it (`cat`, `dd if=`, a `<`
redirect, etc.). No single command profile owns that cross-command condition; the
only non-duplicative home is the shared classifier in `analyze.ts` (`finalize`),
in the situation-2 branch that currently reads
`allowed &&= effects.length > 0 && effects.every((e) => e.kind === "read")`.

Adding a rule there changes a situation's rule and introduces a red-line-style
carve-out where situation 2 currently has none. Per ARCHITECTURE §7 an ordinary
extension must "avoid classifier or aggregator exceptions," and per §8 altering a
situation or adding a red line is architectural. The code is small, but the
change is not a profile widening, so it takes a record. There is precedent on
both sides: the situation-1 `.git` red line (`hasGitSegment`) is the same
"certain resolved paths force ask inside an otherwise-allowing situation"
concept, and `RISKY_ENVIRONMENT_NAMES` is an accepted conservative high-risk
curated list — this decision is those two ideas combined and placed in
situation 2.

## Affected contract

- Situation 2 rule: gains one read red line. Recognized external reads still
  allow **except** when a target resolves under a designated sensitive root.
- Trust boundary: adds "designated sensitive absolute paths are not auto-approved
  for external read." This is a documented trust assumption, listed alongside the
  lexical-containment boundary.
- Product invariants: unchanged. The change only narrows `allow` toward `ask`; it
  never turns an `ask` into an `allow`, and it does not introduce
  "no known danger found, therefore allow."
- Decision units, fact kinds, structural completeness, the other two situations,
  and aggregation: unchanged. No new decision-unit kind and no new fact kind — the
  rule consumes the resolved path and effect kind that `finalize` already
  computes.

## Alternatives

1. **Leave situation 2 as-is** (status quo): all recognized external reads allow.
   Rejected — it is the problem above; accidental credential disclosure has no
   checkpoint.
2. **Stop auto-approving all external reads.** Rejected — it erases a large,
   genuinely useful allow surface (reading system and home files during ordinary
   work) and would sharply raise the prompt rate, defeating the tool's purpose.
3. **A conservative sensitive-path read red line in situation 2** (this ADR):
   default-allow preserved, a small high-signal denylist flips to `ask`.

## Decision

Introduce a single shared red-line predicate over resolved paths, evaluated in
the situation-2 read branch of `finalize`.

- A new module `src/policy/sensitive.ts` exports a finite, conservative default
  set of sensitive roots and `isSensitiveTarget(resolvedPath, homedir, extra)`.
- Default roots (home-relative entries resolved against `ctx.homedir`, absolute
  entries kept absolute), e.g.:
  `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`, `~/.docker/config.json`,
  `~/.config/gcloud`, `~/.config/gh`, `~/.netrc`, `~/.git-credentials`,
  `~/.npmrc`, `~/.pypirc`, `~/Library/Keychains`, `/etc/shadow`.
- Matching reuses the existing lexical containment shape: a path matches a root
  when it equals the root or lies under `root + path.sep`. So `~/.ssh` and
  everything beneath it matches, while a sibling like `~/.sshfoo` does not.
- The predicate is consulted in situation 2 only, and only for `read` effects. A
  read whose resolved target matches asks with reason `sensitive external read`.
  External writes already ask, so writes need no new rule.
- **User extension is additive only.** Plugin options may supply extra sensitive
  roots that are unioned with the defaults; options can never remove a default.
  This keeps the change fail-closed: configuration can only add prompts.

Situation 1 is intentionally unchanged. Reads inside the workspace stay allowed
even if a path is named like a secret; if a user's workspace root *is* their home
directory, everything under it is already trusted by situation 1, and that
pre-existing property is out of scope here.

## Complexity bound

One finite static set of absolute path roots, home-expanded once per
`WorkspaceContext`, plus optional additive user roots. Per read effect the cost
is a bounded prefix comparison against that set. No new state, no command-order or
shell-state simulation, no history traversal, no new decision-unit or fact kind.
The set is a fixed catalogue like `RISKY_ENVIRONMENT_NAMES`; growing it later is
an ordinary profile-style edit, not a further architecture change.

## Fail-closed behavior

- Unresolved / dynamic read target: already indeterminate and already asks;
  unchanged.
- Resolved target under a sensitive root: asks.
- Malformed, partial, or resource-exhausted input: unchanged — the earlier
  parse/normalize/budget stages still ask before this rule is reached.
- If `homedir` is unavailable, home-relative roots simply do not expand; absolute
  roots (`/etc/shadow`) still apply. A path that cannot be matched falls back to
  the current allow — a miss equals the status quo and never regresses safety in
  the unsafe direction.

## Cross-model consistency

The three situations keep their meaning and precedence. Situation derivation is
untouched — a target is still classified external first, then the read red line
applies within situation 2, mirroring how the `.git` red line applies within
situation 1. Structural completeness, unit composition, and stability-conflict
aggregation are unaffected because no unit, fact, or mutation scope is added; the
rule only downgrades an already-external read unit to `ask`. Aggregation stays
order-independent and command-agnostic. The `edit` gate is deliberately not
touched: reading is not editing, and editing a sensitive file already follows the
separate `edit` path policy.

Honesty about limits, to be documented, not papered over:

- The denylist is **best-effort and incomplete**. Because the default remains
  allow, a missing entry reverts to today's behavior rather than creating a false
  guarantee — but the docs must state plainly that this is not a completeness
  claim.
- Matching is **lexical**, consistent with the existing containment boundary.
  `cat ~/symlink-to-ssh` is not caught. This is the same accepted trust boundary
  as workspace containment, not a new weakness.

## Counterexamples and tests

Positive (still allow):

- `cat /etc/hosts`, `cat ~/notes.txt`, `ls -la /tmp`
- `cat README.md` and other situation-1 reads inside the workspace, even a file
  incidentally named like a secret.

Now ask (new behavior):

- `cat ~/.ssh/id_ed25519`, `head -c 100 ~/.ssh/id_rsa`
- `cat ~/.aws/credentials`, `cat ~/.netrc`, `strings ~/.gnupg/secring.gpg`
- `cat < ~/.ssh/id_rsa` (read via redirect), `dd if=~/.aws/credentials`
- `cat /etc/shadow`

Adjacent rejected-match (must still allow — boundary correctness):

- `cat ~/.sshfoo`, `cat ~/.aws-notes` (siblings, not under a root)

Traversal / normalization:

- `cat ~/.ssh/../.ssh/id_rsa` normalizes under `~/.ssh` and asks.

Adversarial / boundary:

- `cat ~/symlink-to-ssh` is not caught (documented lexical limit).
- Situation-1 read of a workspace file named `credentials` still allows.

Architecture-contract regressions:

- Situation precedence and the situation-1 `.git` red line are unchanged.
- External writes to a sensitive path still ask via the existing external-write
  rule, not this one.

## Migration and compatibility

External reads of the listed sensitive paths now prompt instead of
auto-approving — a small, safe-direction increase in prompts. No data migration,
no change to released decision behavior for any non-listed path. A new context
picks up any additive user roots from plugin options.

## Documentation updates

- `ARCHITECTURE.md` §4.2: add the situation-2 read red line and note it as a
  trust boundary, symmetric to the situation-1 `.git` red line.
- `README.md`: in the "Outside the workspace" section, add that a small set of
  sensitive paths asks, with one `ask` example, and state the best-effort /
  lexical caveats.
- `DEVELOPMENT.md`: record `src/policy/sensitive.ts` in module ownership and its
  profile-style test file.
- Tests: add situation-2 red-line coverage (positive, new-ask, adjacent, and
  traversal cases) in the workspace/situation contract tests, plus a focused
  sensitive-path test.
- `AGENTS.md`: no change.

## Approval

Accepted explicitly by the maintainer on 2026-09-10.
