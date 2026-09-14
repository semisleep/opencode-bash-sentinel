---
name: why-ask
description: Explains why bash commands received an "ask" verdict from opencode-bash-sentinel instead of auto-approve, and evaluates what supporting them would cost. Pure analysis — implementation is handed off to the fix-profiles (cost=profile) and evaluate-adr (cost=ADR) skills. Use when the user asks why commands keep prompting, wants recent asks reviewed from the audit history (no pasting needed), pastes commands that look harmless but still prompt, or asks what it takes to auto-allow a new command or flag. Defaults to the N=10 most recent distinct ask commands; cache-hit entries inside that N-record window are skipped, and the remainder is analyzed (unless the user explicitly asks to re-analyze).
---

# Explain and evaluate "ask" verdicts

Two intake modes:

- **History mode (default)**: collect the ask commands yourself from the
  runtime audit log — the user does not need to paste anything. Default
  scope: take the N most recent *distinct* ask commands, where N defaults
  to 10; from those N records, drop the ones already covered by the
  conclusions cache, and analyze ALL of the remainder (N minus cached —
  the window is NOT topped up with older records to compensate for cache
  hits). Never ask the user which entries to check — no
  question dialog, no selection step; any ambiguity about scope resolves
  silently to the default batch, and you just state the chosen scope in
  the output. Only if the user's request names a count ("最近 20 条",
  "last 5", "再往前 50 条") does N change.
- **Paste mode (fallback)**: the user pasted specific commands, or audit is
  off and there is no history to read.

Your job is a forensic answer, nothing else: find the exact rule that
produced each ask, judge whether the command is genuinely harmless, and if
so classify what supporting it would cost — profile-level work or an
architecture decision. Do not implement anything; hand off to
`fix-profiles` / `evaluate-adr` at the end.

## Step 0 — Collect candidates and check the cache

1. Audit log: `~/.local/share/opencode/bash-sentinel-audit.jsonl` (JSONL,
   one event per line; ask events look like
   `{"gate":"bash","command":"...","reason":"...","action":"escalate"}`).
   It only exists while `audit: true` is set in the plugin config.
2. Extract recent asks with one plain command:

   ```bash
   rg '"action":"escalate"' ~/.local/share/opencode/bash-sentinel-audit.jsonl | tail -200
   ```

   If that prompts, fall back to `wc -l` on the file plus the Read tool
   with an offset near the end. Do not write ad-hoc jq/python parsers for
   this — parse the JSONL lines yourself.
3. From those lines, build the candidate list: drop `gate:"transport"`
   lines; dedup by exact command string (the most recent occurrence wins,
   its `reason` is the ground truth); order most-recent-first. Near-
   duplicates that differ only in arguments are separate entries.
4. Version check: each audit line's `build` field names the code that
   produced it (`git rev-parse --short HEAD` captured when the opencode
   process loaded the plugin, `+dirty` when engine sources were
   uncommitted; lines from before this field existed carry none). Compare
   it with the repo's current `git rev-parse --short HEAD`. On mismatch
   (or missing field), those verdicts came from older code: reproduce
   with the current analyzer and let IT govern the cost assessment,
   report both readings, and tell the user to restart opencode to load
   current code. There is no build step — the plugin loads repo source
   directly, so "stale build" always means "stale process".
5. Sanity check: if a `(transport probe)` degraded line sits near those
   timestamps, the asks may be transport failure (all-prompts mode), not
   analyzer verdicts — say so and stop.
6. Cache filtering — read `.agents/skills/why-ask/cache.json` (repo-
   relative, gitignored per-checkout local state — never commit it) if it
   exists (schema below), then apply it to the candidate list:
   - a candidate whose exact command AND `reason` both match a cache
     entry has already been analyzed → **skip it by default** — it still
     occupies one of the N collected records (it is not replaced by an
     older record), is not re-analyzed, and is reported only as a
     skipped count;
   - a candidate whose command matches a cache entry but whose `reason`
     differs is NOT considered cached — the analyzer changed, re-analyze
     and overwrite the entry;
   - the user explicitly asked to re-analyze ("重新分析", "re-analyze",
     "ignore cache", "再查一遍") → ignore the cache filter for the whole
     batch and analyze everything;
   - entries whose cache summary already says FIXED are still skipped —
     being fixed is the strongest form of "already handled"; report them
     only as a count.
7. Fix the analysis window BEFORE filtering: take the first N (default 10)
   candidates from the most-recent-first list. Then remove the cached ones
   (rule 6) — the analysis batch is exactly the remainder, N minus the
   skipped count; do NOT walk further back in the log to top the batch
   back up to N. If some remain, analyze all of them and say how many of
   the N were skipped as cached. If nothing remains, report that all N
   recent asks are already analyzed (N skipped) — offer re-analysis only
   if the user asks for it, do not run it on your own.
8. If the log is missing or has no escalate lines: report that audit
   appears off and fall back to paste mode.

## Step 1 — Reproduce with the real analyzer, never by guessing

The audit line already carries the engine's `reason` — that is ground
truth. Reproduce locally with the resident probe. Write the batch to
`.agents/skills/why-ask/probes.txt` (gitignored scratch; one command per
line, `#` comments allowed) with the Write tool, then run:

```bash
npx tsx .agents/skills/why-ask/probe.ts --units .agents/skills/why-ask/probes.txt
```

The probe uses the real default workspace context (live git baseline), so
its verdicts match the runtime plugin for this checkout, and the invocation
auto-approves when the session workspace is this repo with a clean,
baseline-committed `package.json` declaring `tsx`. Commands travel via the
file (or stdin) — never argv: wildcard- or `$`-bearing arguments fail the
visible-argument check and would prompt. A single quick command without
wildcards can also be piped: `printf '%s\n' 'cmd' | npx tsx .agents/skills/why-ask/probe.ts`.

Context sensitivity is real and often IS the answer: `cwd` vs `workspace`
drift, a dirty git tree (git destructive ops escalate only when dirty),
sensitive roots under `$HOME`. The audit log does NOT record cwd/baseline.
The resident probe always uses the LIVE context; for counterfactuals (fake
clean/dirty baseline, foreign homedir, both-cwd comparison), fall back to a
throwaway script in the system temp dir and expect exactly one prompt:

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

When the reason is context-sensitive ("external write", "sensitive external
read", git dirt-gated forms), rerun under both baselines and say explicitly
that the verdict depends on context.

Read `decision.reason` — it names the failing rule (e.g. "unsupported ...
option", "unrecognized command", "not a single supported command",
"sensitive external read", "external write", ".git red line"). Map it to
the constitution section it comes from (`ARCHITECTURE.md` §3 completeness /
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

### 4b. Class-level observations, not implementation plans

Mapping exact files and edits is the `fix-profiles` skill's job. What this
skill records is the analysis a fixer needs:

- The verdict line: `profile-level, no invariant touched` or
  `architecture — ADR required because <which invariant/section>`.
- Dangerous cousins: does the same syntax family carry a harmful variant
  that any fix must exclude (the `find` operators, `sort -o`,
  `--upload-pack`, `rg --pre`)?
- Class-level observations: is this an isolated gap or one instance of a
  wider class (e.g. "all long forms missing for this tool", "no `=`-
  attached value support in the shared option parser", "the sibling
  tool sharing this table has the same hole")? Say so explicitly — the
  fixer is required to fix the class, not the symptom.
- Interaction with aggregation: can the newly allowed form appear as one
  leg of a composed line where the OTHER leg is what escalates? (Fine —
  aggregation stays worst-case — but say so.)

## Step 5 — Write back the cache

After analyzing, update `.agents/skills/why-ask/cache.json` (repo-relative,
gitignored; JSON, this schema — keep an `entries` array, newest first,
capped at 200):

```json
{
  "entries": [
    {
      "command": "rg -r ... | head",
      "reason": "dynamic rg",
      "conclusion": "correct-ask | should-allow",
      "cost": "none | profile | ADR",
      "summary": "one-line explanation naming the triggering fact/rule",
      "analyzedAt": "2026-09-12T13:30:00.000Z"
    }
  ]
}
```

- Write the file only when at least one entry was added or overwritten —
  an all-cached run must not rewrite it.
- The cache path is inside the workspace, so the write auto-approves
  without a prompt; that is the reason it lives in the repo. Keep it
  gitignored — it is per-machine local state, not project content.
- Do not store multi-paragraph essays in `summary` — one line; the full
  reasoning lives in your reply, not the cache.

## Output

- State the chosen scope: the value of N, how many of the N records were
  skipped as already cached, and what the analyzed batch (N minus
  skipped) is.
- New commands: full per-command treatment (Steps 1–4).
- Finish with a summary table: command / correct-ask vs should-allow /
  cost (none | profile | ADR) / triggering rule.
- End with a handoff — no implementation, just the pointer:
  - entries with `cost=profile` → the `fix-profiles` skill;
  - entries with `cost=ADR` → the `evaluate-adr` skill.

## Rules

- Analysis only. Do not edit `src/`, `test/`, or docs while running this
  skill — fixes belong to `fix-profiles`, architecture questions to
  `evaluate-adr`.
- Cached (command, reason) pairs are skipped, not re-served and not
  re-analyzed; only an explicit user request re-opens them.
- A cache entry whose `reason` no longer matches the audit line is stale,
  not cached — re-analyze and overwrite it; never skip (or serve) on a
  stale reason.
- Probe with the resident probe first (`.agents/skills/why-ask/probe.ts` +
  `probes.txt`); throwaway scripts go in the system temp dir, are used only
  for counterfactual contexts, and are deleted afterwards.
- If the runtime reason and your local reproduction disagree, the runtime
  context (baseline, cwd, audit line) wins — report both and explain the
  difference — unless the audit `build` field identifies stale code (see
  Step 0), in which case the current-analyzer reproduction governs.
- Never pop a question dialog asking which log entries to analyze —
  default to the N=10 most recent distinct ask commands, skip the cache
  hits inside that N-record window, and check every remaining one; only
  the user's explicit count request overrides N.
