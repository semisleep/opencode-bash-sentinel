---
name: evaluate-adr
description: Triages ADR-level findings from the why-ask skill (cost=ADR) along two axes — whether the architecture decision record is actually worth doing, and whether the same agent-behavior correction could instead be achieved without any engine change by reworking the advisory guidance text (DEFAULT_GUIDANCE in src/plugin.ts or the per-project guidance config) so agents reach for shapes the analyzer already allows. Use when why-ask marks a finding architectural, or the user asks whether some unsupported shape deserves an architecture change.
---

# Evaluate ADR candidates

Input: why-ask conclusions with `cost: "ADR"` (from
`.agents/skills/why-ask/cache.json` or the conversation), or a shape the
user asks about. Output: a recommendation — do the ADR, fix via guidance,
or leave fail-closed — with evidence. This skill never implements an
architecture change; per AGENTS.md that needs an approved decision record
first.

## Step 0 — Ground the case

- Read `ARCHITECTURE.md` §8 (the nine ADR questions) and the invariant the
  finding implicates (§1–§6). Quote the exact invariant text in the reply.
- Reproduce the ask with the resident probe
  (`.agents/skills/why-ask/probe.ts` + `probes.txt`) so the analysis argues
  about current code, not memory.
- Confirm the shape really cannot be profile-level: re-check against the
  §7 extension contract (the why-ask classification did this once; verify,
  don't trust).

## Step 1 — Axis one: is the ADR worth doing?

Answer with evidence, in this order:

1. Frequency: how often does the shape family appear in the audit log?
   One plain command finds it:

   ```bash
   rg -c '<family marker>' ~/.local/share/opencode/bash-sentinel-audit.jsonl
   ```

   Count both the exact command and near-variants (different arguments).
   A shape that asked twice this month is not an ADR; one that asks daily
   might be.
2. Cost per §8: which new mechanism does the ADR introduce —
   execution-order or shell-state simulation, reparse of data, a new fact
   kind, a redefined situation? The §2 trust boundaries "may be changed
   only as architecture decisions, not by quietly widening a command
   profile" — so the ADR must argue why the widened trust stays
   self-consistent, not merely convenient.
3. Adversarial surface: what confused-deputy or smuggling shapes become
   allowed as a side effect? Name at least two concrete attacks the new
   model must still fail closed on.
4. Verdict on this axis: worth it / not worth it / borderline, with the
   deciding reason.

## Step 2 — Axis two: can guidance replace the ADR?

The engine ships an advisory system-prompt nudge — `DEFAULT_GUIDANCE` in
`src/plugin.ts` (search for "Bash gate guidance"), configurable per project
through the plugin's `guidance` option (boolean | string). It never
affects verdicts; it steers the agent toward shapes the analyzer already
allows. Existing precedents inside that text: "run the producer first,
read its output, then rerun with the literal" (replaces dynamic
substitution), "split mixed `&&`/`;` lines", "use the edit tool instead of
scripted rewrites".

Evaluate whether the same goal the ADR would serve can be met by steering:

1. Find an alternative shape that already auto-allows and achieves the
   same task (probe it to prove it allows — never document a workaround
   the analyzer would still ask for).
2. Draft the guidance sentence(s) in the style of the existing bullets:
   concrete before/after example pair, states what prompts and what runs
   unattended.
3. Assess honestly: guidance is advisory (agents can ignore it) and
   per-project, but it carries zero engine risk, no invariant change, and
   lands immediately. An ADR is deterministic and universal, but costs a
   mechanism, an invariant adjustment, and maintainer approval.
4. If a guidance fix works, say whether it fully replaces the ADR or only
   mitigates it (frequency argument: guidance may be enough at low
   frequency, insufficient at high frequency).

## Step 3 — Recommendation matrix

| Situation | Recommendation |
| --- | --- |
| Rare shape + expressible alternative | Guidance fix (or nothing) |
| Frequent + expressible alternative | Guidance fix first, re-measure audit log afterwards; ADR only if asks persist |
| Frequent + no equivalent allowed form + passes §8 | Draft the ADR proposal |
| Fails §8 smell test (mechanism too broad, adversarial surface too hot) | Leave fail-closed; document as accepted gap |

## Step 4 — Output

- Verdict with both axes stated separately (ADR-worthiness, guidance
  alternative), each backed by the evidence gathered above.
- If recommending an ADR: present the proposal skeleton in the reply
  following §8's nine points (frequent problem, why profiles can't solve
  it, touched invariants, alternatives, complexity bound, situation and
  aggregation effects, fail-closed behavior and adversarial tests,
  migration, self-consistency). Write it to `docs/architecture-decisions/`
  only when the user asks — do not create the file on your own.
- If recommending a guidance fix: show the exact sentence(s) to add or
  change in `DEFAULT_GUIDANCE` (or the per-project `guidance` config
  string), plus the probe-verified example pair. Editing `src/plugin.ts`
  needs the user's explicit go-ahead — propose, don't edit.
- Update the why-ask cache entry: prefix the summary with
  `ADR-TRIAGE <date>: <recommendation>` so later runs skip it and the
  decision trail is visible.

## Rules

- Never modify the engine, profiles, or `src/plugin.ts` while running this
  skill — it produces decisions and drafts, not code.
- Never bypass an invariant argument with "it's just a small change"; if
  the shape truly needs §8, the ADR must say so plainly.
- The audit log is the frequency evidence; do not argue frequency from
  anecdotes.
