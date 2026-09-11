---
name: review-changes
description: Reviews recent functional changes to opencode-bash-sentinel for architecture violations, invariant breaches, regressions, and newly introduced issues. Default scope is the functional changes from the most recent conversation turn(s); a user-specified scope (commit range, files, working tree) always overrides. Mechanically probes the real analyzer, then triages findings as new-regression vs pre-existing vs acceptable fail-closed gap.
---

# Review recent functional changes

Review, don't re-implement. The input is a set of changes (by default, the
functional edits made in the previous conversation turn); the output is a
verdict on whether they are safe, whether they touch architecture or core
logic, and whether they introduce new problems — with evidence, not opinions.

## Step 0 — Resolve the review scope

- If the user named a scope (commits, branch range, files, PR), review exactly
  that.
- Otherwise the scope is the functional changes from the most recent
  conversation turn(s). Locate them mechanically, never from memory:

```
git status --short && git diff --stat          # uncommitted changes?
git log --oneline -5                            # else find the fresh commit(s)
git show <commit> --stat && git show <commit>   # inspect the actual hunks
```

  Changes are often already committed between turns, so an empty `git diff`
  means "find the commit", not "nothing to review". Confirm the diff contains
  only files the conversation actually touched — anything extra is a scope
  violation and gets reported first.

## Step 1 — Map every hunk to the constitution

Read `ARCHITECTURE.md` before judging anything (AGENTS.md requires this for
policy work). For each hunk, attribute it to exactly one bucket:

- **Profile-level** (§7 extension contract): option tables, `validArguments` /
  `validTail` guards, recognizers, and tests under `src/policy/profiles/` and
  `test/profiles/`. This is where ordinary widening is allowed.
- **Core / architectural** (§8): anything in `src/policy/analyze.ts`,
  `normalize.ts`, `redirect.ts`, `paths.ts`, `sensitive.ts`, the decision-unit
  or aggregation model, the three situations, red lines, trust boundaries, or
  the permission-gate boundary. A functional change here without an approved
  ADR is a finding by itself — report it, do not rationalize it.

Judge each widened allow surface against the invariants (§1): positive
recognition, fail-closed for unknowns, worst-case aggregation, the `.git` and
sensitive-root red lines, workspace-root deletion.

## Step 2 — Ground-truth every newly allowed form

For each option, flag, subcommand, or program grammar the change now allows:

- Verify against real unix tool semantics (not man-page folklore) that the
  form is read-only or harmless in every position it can occupy.
- Enumerate its dangerous cousins: value-taking variants (`-o` vs `-oVALUE`),
  case siblings (`-a` vs `-A`), writing modes (`sort -o`, `sed w/e/r`,
  `--upload-pack`), execution side doors (`--pre`, `-e`), and option
  terminators (`--`) whose semantics are position-dependent.
- For position-blind tables, check the misparse direction: a misread that
  stays read-only→read-only is tolerable; any misread that turns a write or
  exec shape into an allow is a finding.
- If the widening is shared (one table serving sibling tools), confirm it
  cannot leak onto a sibling where the same syntax means something dangerous.

## Step 3 — Probe mechanically with the real analyzer

Write a throwaway script in the system temp dir (never the repo), run with
`npx tsx`, print only mismatches, delete afterwards:

```ts
import { analyzeWorkspacePolicy } from "<repo>/src/workspace-policy"

const ctx = {
  workspace: "/work/project",
  cwd: "/work/project",
  homedir: "/home/dev",
  baseline: { status: () => "clean" },  // flip to "dirty" for git probes
  extraSensitiveRoots: [],
}

type Case = [source: string, expected: "allow" | "ask", note: string]
const cases: Case[] = [ /* fill per Step 2 */ ]

let mismatches = 0
for (const [source, expected, note] of cases) {
  const d = analyzeWorkspacePolicy(source, ctx)
  if (d.action !== expected) {
    mismatches++
    console.log(`MISMATCH want=${expected} got=${d.action} (${d.reason}) :: ${source}  -- ${note}`)
  }
}
console.log(`${cases.length} probes, ${mismatches} mismatches`)
```

Cover every changed surface with all six probe classes:

1. **Approved forms allow** — the change actually works, including composed
   and piped variants of the motivating command.
2. **Scoped fail-closed pins** — sibling shapes the change must NOT have
   widened (other subcommands, sibling tools sharing a table, `-A` vs `-a`
   case pins, repeated flags, unknown long options).
3. **Dangerous cousins ask** — every harmful variant enumerated in Step 2.
4. **Red lines hold** — `.git` mutation, sensitive-root reads
   (`/etc/shadow`, `~/.ssh`, `~/.aws`), workspace-root deletion, external
   writes, each attempted through a newly allowed form.
5. **Worst-case aggregation** — newly allowed forms as one leg of a composed
   line whose other leg is dangerous; the whole line must ask.
6. **Dynamic and smuggling shapes** — `$(...)` substitutions into the widened
   command, redirects of its output to sensitive/external targets, embedded
   newlines or look-alike characters in operands.

Also rerun context-variants when relevant: dirty baseline, `cwd` drift.

## Step 4 — Verify the test suite honestly

Run the full suite and typecheck (`npm test`, `npm run typecheck`). For every
failure, prove whether it predates the change before blaming it:

```
git stash && npx vitest run <failing file>; git stash pop
```

A failure that reproduces on the clean tree is pre-existing — report it as
such, separately from the review verdict. Check that the change's own tests
pin BOTH directions: the new allows and the fail-closed neighbors. An
allow-only test addition is a test gap.

## Step 5 — Triage and report

One entry per finding, ordered by severity:

```
### F1 <one-line title>
Change:   which hunk introduced it (or: pre-existing, surfaced by review)
Sample:   the exact probe
Verdict:  allow/ask (expected: the opposite)
Known?    YES — cite ARCHITECTURE.md §, README, or ADR-XXXX  |  NO
Risk:     within disclosure / BEYOND because ... (accidental vs deliberate, invariant touched)
Cause:    profile — <file>:<function>  |  architecture — <which invariant/section>
Fix path: profile edit + tests (no ADR) | ADR required | test-only
```

End the report with:

1. **Architecture verdict**: one line — profile-level only, or which
   invariant/section was touched.
2. **Invariant checklist**: fail-closed / positive recognition / worst-case
   aggregation / red lines / trust boundaries, each with the probe count or
   test that vouches for it.
3. **Finding count by category**: new-regression, pre-existing surfaced,
   acceptable fail-closed gap, test gap.
4. **Coverage holes**: which probe classes you did not run.

Observations that are NOT caused by the change under review still belong in
the report, but must be labeled pre-existing with their own attribution —
never let them silently pad (or excuse) the verdict.

## Rules

- Analysis only while this skill runs — no edits to `src/`, `test/`, or docs.
  Fixes happen after the maintainer picks a direction (AGENTS.md).
- Probe scripts live in the system temp dir and are deleted afterwards.
- Never blame the change for a failure you haven't reproduced on the clean
  tree; never credit the change for behavior that predates it.
- If runtime audit lines (`~/.local/share/opencode/bash-sentinel-audit.jsonl`)
  contradict local reproduction, report both and prefer the runtime context.
