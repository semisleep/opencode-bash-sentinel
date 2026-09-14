---
name: fix-profiles
description: Fixes profile-level "should-allow" findings produced by the why-ask skill — missing commands, options, or option spellings in src/policy/profiles/. Use when the user asks to fix, implement, or widen command profiles after a why-ask run (cache entries with cost=profile), or to add support for specific read-only commands/flags. Enforces class-level generalization: one symptom is fixed together with its whole family (short+long spellings, sibling tools, attached-value forms, help/version shapes), with dangerous cousins pinned to ask.
---

# Fix profile-level findings

Input: why-ask conclusions (`.agents/skills/why-ask/cache.json` entries with
`conclusion: "should-allow"` and `cost: "profile"`, especially ones not yet
marked FIXED), or commands/flags the user names directly. Output: profile
and test edits that turn exactly the harmless class into allows while every
unknown or harmful neighbor keeps asking.

## Step 0 — Read the contract first

AGENTS.md and `ARCHITECTURE.md` govern this work. Before touching code:

- Read `ARCHITECTURE.md` §7 (extension contract) and §8 (what is
  architectural). Profile widening must add *positively identified safe
  forms* to an existing allow surface — never reduce fail-closed behavior.
- Profile-level changes must NOT touch `README.md`; the executable
  specification lives in `test/profiles/`.
- If any part of the fix seems to need `normalize.ts`, decision-unit
  handling, situation semantics, or an invariant change → stop and hand the
  case to the `evaluate-adr` skill instead. Do not improvise.

## Step 1 — Reproduce before fixing

Confirm the gap is real with the resident probe. Write the failing shapes
to `.agents/skills/why-ask/probes.txt` (one command per line, `#` comments
allowed) and run:

```bash
npx tsx .agents/skills/why-ask/probe.ts --units .agents/skills/why-ask/probes.txt
```

Everything you intend to fix must currently ask; everything already allowed
is out of scope. Keep this file — you will re-run it after the fix, with
the expected verdicts inverted.

## Step 2 — Generalize: fix the class, not the symptom

This is the core discipline. A single missing flag is almost never an
isolated gap; fix its whole family in the same pass:

- Short flag added → check the long form(s) and the glued/attached
  spellings (`-d`, `--directory`, `-d1`, `--flag=VALUE`) and support the
  safe ones; long form added → check the short alias.
- One tool widened → sweep its sibling tools sharing the table or class
  (the grep/rg split exists precisely because spellings differ across
  siblings), and other tools with the same convention (e.g. when adding
  `--lines` for head, check tail and wc).
- New option family → consider the standard families: help/version usage
  forms, numeric shorthands (`-3`), attached values (`--flag=VALUE` with a
  closed value set), cluster letters.
- Shared mechanism missing (e.g. no `=`-attached long-value support in the
  option parser) → extend the shared mechanism once, with per-grammar
  whitelists, instead of one-off hacks per profile.

Sweep the family with the probe (Step 1) before implementing: the batch
you fix should include the class representatives, not just the command the
user pasted. State explicitly in the final report which class members you
fixed and which you deliberately left fail-closed with why.

## Step 3 — Implement with fail-closed discipline

- Whitelist grammar, never blacklist: unknown options, unknown values,
  unknown adjacent forms must keep asking by construction.
- Dangerous cousins are excluded by the grammar itself — `find -exec/-delete`,
  `sort -o`, `rg --pre`, sed's `w/W/r` program commands, git's mutating
  subcommands must not ride along with the widened family.
- Value-taking options: prefer attached-only forms (`--flag=VALUE`) with
  closed value sets (enum | numeric). If a separate-value form could
  swallow a path operand, leave it unsupported and say why.
- Multi-word subcommands (e.g. `git stash list`) need explicit action
  gating: only the read-only action allows; the mutating default action
  and every unknown action must ask.
- Existing pins that flip because of the widening are deliberate semantic
  changes: update them with a comment explaining the reading (see the
  `sed -i '1d'` GNU/BSD note in `test/profiles/sed.test.ts` for the style).

## Step 4 — Tests are the specification

For each touched profile, extend `test/profiles/<name>.test.ts`:

- allow pins for every class member you widened;
- ask pins for dangerous cousins, unknown-adjacent shapes, malformed
  values, and missing option values;
- ask pins for red-line compositions through the new surface
  (`<new form> && rm -rf .git`, `<new form>; git push`, sensitive reads).

Do not touch `README.md` (AGENTS.md). Do not weaken
`test/plugin.test.ts` architecture-contract pins; extend them only if the
runtime verdict contract itself changed.

## Step 5 — Verify mechanically

```bash
npm test && npm run typecheck
```

Then re-run the probe batch from Step 1 plus an adversarial batch
(dangerous cousins, red-line compositions, sensitive paths): every shape
must now produce exactly its intended verdict — no lucky allows, no
over-asking. Clean up `probes.txt` afterwards.

## Step 6 — Write back the handoff state

Update the why-ask cache entries you fixed: prefix the summary with
`FIXED <date>: <mechanism>` (keep `conclusion`/`cost` unchanged) so future
why-ask runs still skip these commands and humans can see the resolution.
If a shape turned out to be architectural mid-fix, leave its entry alone
and report it as `evaluate-adr` input instead.

## Rules

- Never commit, push, or create PRs unless the user explicitly asks in the
  current conversation (AGENTS.md).
- Only `src/policy/profiles/**` and `test/profiles/**` may change. Anything
  else (engine, docs, README) is out of bounds; architectural urges go to
  `evaluate-adr`.
- Every widened form ships in the same change as its pins; no "tests
  later".
- Remind the user that fixes take effect only after opencode restarts —
  the plugin loads repo source at process start.
