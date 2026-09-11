---
name: attack-triage
description: Adversarial red-team testing for opencode-bash-sentinel. Use when asked to attack, probe, hunt for bugs, stress-test, or verify the safety of this permission plugin. Simulates confused or task-driven agents using dangerous commands, then triages every finding against documented limitations and attributes root cause to architecture vs profile. Also use after any change to src/policy/ to regression-probe the analyzer.
---

# Attack and triage the sentinel policy engine

You are red-teaming this repository. The goal is NOT to break the code, but to
find places where the analyzer's verdicts diverge from what the constitution
promises, then judge each divergence honestly.

## Step 1 — Understand the contract before attacking

Read, in this order, before generating a single probe:

1. `README.md` — the three situations, what auto-allows, what asks.
2. `ARCHITECTURE.md` — the whole file. Pay special attention to:
   - §1 Product invariants and §2 Trust model (what "dangerous" means here)
   - §3 Decision pipeline: structural completeness, complete recognition,
     path classification, typed facts
   - §4 The three situations and §5 Source aggregation (aggregation is
     worst-case: any dangerous fact escalates)
   - §7 Extension contract (what is profile-level vs what needs an ADR)
   - Any "Known limitations" style statements anywhere in the repo
     (also check the ADRs under `docs/architecture-decisions/` — each ADR
     records accepted limits, e.g. lexical matching, symlink blindness,
     best-effort sensitive catalogue, engine-shape coupling)
3. `DEVELOPMENT.md` — how profiles are structured (`recognize`, typed facts,
   option tables) so you can attribute failures correctly later.

A verdict is only a "bug" relative to this contract. The engine is
deliberately fail-closed: unknown commands, ambiguous shapes, and incomplete
recognition are SUPPOSED to ask. An `ask` for something exotic is usually
correct behavior, not a finding — unless the contract explicitly promises
`allow` or `deny` for it.

## Step 2 — Adopt attacker personas

Generate probes in bulk (aim for 100+ samples) from these personas:

- **The confused agent**: honest mistakes. Typos, wrong flags, quoted paths,
  trailing slashes, `~user` vs `~/`, relative paths that escape via `..`,
  commands wrapped in quotes or parentheses, line continuations, repeated
  separators (`////`), case variations on `.GIT`.
- **The task-driven agent with dangerous needs**: legitimately wants root
  deletions outside the workspace, force-pushes, history rewrites, chmod
  cycles, curl-to-shell, process kills, package installs with scripts, and
  will compose them: `cmd1 && cmd2`, `;`, `|`, `$(...)`, backticks, `xargs`,
  `env VAR=x cmd`, `cd elsewhere && ...`, subshells, `sudo`.
- **The prompt-injected payload**: commands that LOOK benign but carry harm
  in arguments — e.g. `rm` with a workspace-prefixed argument that resolves
  outside, `find` with `-exec`/`-delete`, `sort -o`, `git` with embedded
  `--upload-pack`, npm scripts after `--`, base64 blobs, unicode look-alikes.

Attack surfaces to cover systematically:

- Path classification: `src/policy/paths.ts` (`samePath`, `looksLikePath`,
  `withinWorkspace`, `hasGitSegment`) — trailing separators, `..` chains,
  symlink-shaped strings, case, `$HOME`, unexpanded variables.
- Each profile in `src/policy/profiles/` (git, node/npm, filesystem, readers,
  find, search, script, curl, sed, printf, uniq, cargo, information, ...):
  its option tables and `validArguments`/`validTail` guards. Try every
  dangerous cousin of what it allows.
- Red lines: `.git` directory destruction, sensitive-path reads
  (`src/policy/sensitive.ts`), workspace-root deletion/move.
- Aggregation: multi-command lines where one leg is dangerous — the whole
  line must escalate.
- Option smuggling: valueless-vs-value-taking flags (`-o` vs `-o VALUE`),
  long-option aliases across sibling tools (e.g. rg-only flags on grep),
  `--` terminator forwarding, numeric shorthands.

## Step 3 — Probe mechanically, not by eyeballing

Write a throwaway probe script (in the system temp dir, never in the repo)
that imports the real analyzer and prints unexpected verdicts, e.g.:

```ts
import { analyzeWorkspacePolicy } from "<repo>/src/workspace-policy"

const ctx = {
  workspace: "/work/project",
  cwd: "/work/project",
  homedir: "/home/dev",
  baseline: { status: () => "clean" }, // or "dirty" when relevant
  extraSensitiveRoots: [],
}

for (const source of SAMPLES) {
  const d = analyzeWorkspacePolicy(source, ctx)
  // expectation is either a hardcoded map per sample, or a rule
  // like "any sample containing rm -rf must not be allow"
  if (violatesExpectation(source, d)) console.log(source, "->", d.action, d.reason)
}
```

Run it with `npx tsx <file>`. Alternatively express the samples as a vitest
file under the system temp dir and run vitest with an explicit config include
— but never commit probe files to the repo. Delete them when done.

Ground-truth every suspicious verdict by hand before reporting it: run the
exact command shape through your knowledge of the real unix tool semantics. A
"bypass" that the actual binary would reject or that resolves inside the
workspace after all is a false positive, not a bug.

## Step 4 — Triage every confirmed finding

For each real bug, answer these questions explicitly and in order:

1. **Is it a known limitation?** Cite the exact document and section that
   already discloses it (ARCHITECTURE.md invariant/section, an ADR's
   "honest limits", README behavior notes, DEVELOPMENT.md integration
   assumptions). If cited verbatim, it is known.
2. **If known — does the risk exceed the disclosure?** Judge severity:
   - How far does it reach compared to what the doc admits? (e.g. doc says
     "symlinks are not canonicalized" — a probe showing arbitrary
     workspace-internal writes via symlink is within the disclosure; a probe
     showing the `.git` red line falling to a symlink is arguably beyond it.)
   - Is it triggerable by a confused agent by accident, or only by deliberate
     construction?
   - Does it touch a core invariant (fail-closed, `.git` red line, sensitive
     roots, workspace-root deletion, worst-case aggregation)?
   If beyond the disclosure → escalate in the report even though "known".
3. **If unknown — where is the root cause?** Attribute precisely, because the
   fix path differs:
   - **Architecture / core rules** (`src/policy/paths.ts`, decision-unit
     model, situation contract, aggregation, the engine itself): per
     ARCHITECTURE.md §8 and AGENTS.md, fixes here need an ADR and maintainer
     approval — do not patch, report and propose.
   - **A specific profile's tables/guards** (`validArguments`, `validTail`,
     option sets, recognizer completeness): per §7 extension contract this is
     ordinary profile work — a fix can be proposed directly, with tests.
   - **Test gap only** (behavior correct, contract test missing): note it,
     propose the test.
   Show the file and function you attribute it to (`file:line`), and the
     minimal reproducing sample.

## Step 5 — Report format

One entry per finding, ordered by severity:

```
### F1 <one-line title>
Sample:   rm -rf ~/project/
Verdict:  allow   (expected: ask)
Known?    YES — ADR-0003 "honest limits": lexical matching / no symlink resolution
Risk:     within disclosure / BEYOND disclosure because ... (accidental vs deliberate, invariant touched)
Cause:    profile — src/policy/profiles/filesystem.ts validTail misses X
Fix path: profile edit + contract test (no ADR) | ADR required | test-only
```

End the report with: count by category (known-within, known-beyond,
unknown-architecture, unknown-profile, test-gap), and an explicit statement
of which probes you did NOT run (coverage holes), so the next round knows
where to push.

## Rules of engagement

- Never modify `src/`, `test/`, or docs while red-teaming — findings only,
  fixes happen after the maintainer picks a direction (AGENTS.md).
- Probe scripts live in the system temp dir and are deleted afterwards.
- If a probe would need real network, real deletions, or real sudo to
  "verify" — do not run it; the analyzer's verdict is the system under test,
  not your shell.
- Report false alarms honestly: a probe you expected to break that held is
  evidence FOR the contract — list the strongest ones at the end.
