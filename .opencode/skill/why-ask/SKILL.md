---
name: why-ask
description: Explains why a specific bash command received an "ask" verdict from opencode-bash-sentinel instead of auto-approve, and evaluates what supporting it would cost. Use when the user pastes commands that look harmless but still prompt, asks why something asks, or asks what it takes to auto-allow a new command or flag.
---

# Explain and evaluate an "ask" verdict

The user will paste one or more commands that the sentinel turned into an
"ask" (native permission dialog) even though the user believes they are
harmless. Your job is a forensic answer, not a fix: find the exact rule that
produced the ask, judge whether the command is genuinely harmless, and if so
assess the cost of supporting it — including whether that cost is
architectural.

## Step 1 — Reproduce with the real analyzer, never by guessing

Every ask has a machine-readable reason. Get it before forming any theory.

1. If runtime audit is on (`audit: true`), first check the ground truth:
   `~/.local/share/opencode/bash-sentinel-audit.jsonl` — escalate lines carry
   the exact `reason` string the engine emitted for this command.
2. Then reproduce locally in a throwaway script (system temp dir, not the
   repo), run with `npx tsx`:

```ts
import { analyzeWorkspacePolicy } from "<repo>/src/workspace-policy"

const ctx = {
  workspace: "/work/project",
  cwd: "/work/project",        // relative paths resolve against this
  homedir: "/home/dev",
  baseline: { status: () => "clean" },  // flip to "dirty" for git probes
  extraSensitiveRoots: [],
}

console.log(analyzeWorkspacePolicy(process.argv[2] ?? "your command", ctx))
```

Context sensitivity is real and often IS the answer: `cwd` vs `workspace`
drift, a dirty git tree (git destructive ops escalate only when dirty),
sensitive roots under `$HOME`. When a command's verdict surprises the user,
rerun it under both baselines and both cwds before concluding anything.

Read `decision.reason` — it names the failing rule (e.g. "unsupported ...
option", "unrecognized command", "not a single supported command",
"sensitive external read", "external write", ".git red line"). Map it to the
constitution section it comes from (`ARCHITECTURE.md` §3 completeness /
recognition, §4 situations, §5 aggregation, red lines in §1).

## Step 2 — Ground-truth the harmlessness claim

Verify against real unix semantics, option by option. Common traps where
"harmless-looking" is wrong:

- Read-only tools with writing modes: `sort -o FILE`, `find -exec/-delete`,
  `grep -f`, `tee`, `sed` without `-n`, `curl` without output flags,
  `head`/`tail` on `/dev/stdin` of something else.
- Flags that take a value masquerading as valueless: `-o VALUE` vs `-oVALUE`,
  long-option aliases that differ across sibling tools (rg vs grep).
- Composition: `cmd1 && cmd2` escalates if EITHER leg does (worst-case
  aggregation, §5) — the user often only eyeballs leg one.
- Arguments that resolve outside the workspace (`..` chains, `~`, absolute
  paths) or onto sensitive roots.
- Environment/stdin variants: `VAR=x cmd`, `cmd < file`, pipes into
  interpreters.

Only after this do you know which of the two cases you are in.

## Step 3 — Case A: the ask is correct

The command (or one leg of it, or one option of it) carries a real side
effect, targets outside the workspace, hits a red line, or is simply not
positively recognizable. Explain in one short paragraph: which exact
fact/option/leg triggers it, which constitution rule turns that into ask,
and note that fail-closed is the design (an `ask` for the unknown is the
product working, not a bug). No further action needed unless the user
disagrees with the semantics — then it becomes a policy debate, surface the
trade-off and stop.

## Step 4 — Case B: genuinely harmless, could auto-allow — cost assessment

Now answer the user's real question: what would supporting it cost?

### 4a. Does it need an architecture change?

Per `ARCHITECTURE.md` §7 (extension contract) and AGENTS.md, these are
profile-level (NO architecture change, no ADR):

- A new command profile (`src/policy/profiles/<name>.ts` + registry entry)
- Extending an existing profile's option tables / `validArguments` /
  `validTail` / recognizer to cover more read-only forms
- A new read-only syntax entry in `filesystem/readers.ts`, an option
  `numeric` shorthand in `filesystem/options.ts`, a flag class split like
  grep-vs-rg in `search.ts`

It DOES need an architecture change (ADR + maintainer approval, do not
implement) if any of these would be touched — recognize these honestly:

- The decision-unit model or how commands are split/aggregated (§3, §5)
- The three-situation contract or what counts as workspace-internal (§4)
- Any invariant: fail-closed, positive recognition, worst-case aggregation,
  the `.git` red line, workspace-root deletion/move, sensitive-root asking
- The trust model (§2) or permission-gate boundary (§6)
- Anything that would let "allow" come from NOT recognizing something

The boundary heuristic: if the fix only adds positively-identified safe
forms to an allow surface that already exists for that tool, it is profile
work. If the fix asks the engine to be smarter about ambiguity, trust
unrecognized shapes, or redefine what a situation means, it is architecture.

### 4b. Concretely: what changes, what impact

For profile-level work, list the exact edits and their blast radius:

| Change | Files |
| --- | --- |
| New command profile | `src/policy/profiles/<name>.ts`, `registry.ts`, new `test/profiles/<name>.test.ts`, README command coverage |
| Wider options on existing profile | the profile file (e.g. `search.ts`, `readers.ts`, `options.ts`), its test file |
| Both may also touch | `test/plugin.test.ts` contract block if the runtime verdict changes |

Impact questions to answer explicitly, because every widening is a security
decision in disguise:

- Dangerous cousins: does the same syntax family carry a harmful variant
  that must be excluded (the `find` operators, `sort -o`, `--upload-pack`)
  and can the exclusion be expressed in the table, or does it need logic?
- Shared-table blast radius: if the option table is shared (grep/rg class),
  does widening it for one tool leak onto its siblings? (The grep/rg split
  exists precisely because of this.)
- Interaction with aggregation: can the newly allowed form appear as one
  leg of a composed line where the OTHER leg is what escalates? (Fine —
  aggregation stays worst-case — but say so.)
- Test surface: which contract tests pin the current behavior and must be
  extended, not just new ones added.

End with a one-line verdict: `profile-level, ~N files, no invariant touched`
or `architecture — ADR required because <which invariant/section>`.

## Rules

- Analysis only. Do not edit `src/`, `test/`, or docs while running this
  skill — implementing needs the maintainer's go-ahead (AGENTS.md), and
  architecture-level ideas need an ADR proposal, not code.
- Probe scripts go in the system temp dir and are deleted afterwards.
- Answer per command, then a summary table: command / correct-ask vs
  should-allow / cost (none | profile | ADR).
- If the runtime reason and your local reproduction disagree, the runtime
  context (baseline, cwd, audit line) wins — report both and explain the
  difference.
