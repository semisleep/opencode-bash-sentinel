# ADR-0006: OpenCode v2 in-band permission integration

- Status: accepted (2026-09-29; implemented the same day)
- Date: 2026-09-29
- Supersedes: the payload-shape origin identification of ADR-0003; completes
  the deferred write-origin half of ADR-0005 §3. Drops OpenCode 1.x support.

## Problem

OpenCode 2.x replaced the host contract Sentinel is built on. The 1.x adapter
(`src/plugin.ts`) subscribes to `permission.asked`, reads the Bash source from
`metadata.command`, and replies `once` over the SDK or raw HTTP routes. None of
that survives in 2.0.18 (verified against tag `v2.0.18`, cloned under
`.reference/opencode-v2`):

- Plugins are modules exporting `Plugin.define({ id, setup(ctx) })` from
  `@opencode/plugin`; the 1.x `Hooks` object and `@opencode-ai/plugin` are not
  loaded (`packages/core/src/plugin/module.ts`).
- The engine offers an **in-band** decision point instead of a reply channel:
  `Permission.evaluateInput` runs configured `deny` rules first, merges rules,
  then triggers `permission.evaluate` with a mutable `effect`
  (`packages/core/src/permission.ts:171-189`). Whatever `effect` leaves the hook
  is final; `ask` alone creates a pending request and dialog.
- The Bash tool is now `shell`. Its permission request carries **no command
  text**: `resources` are per-command slices produced by the engine's own
  scanner, with no `metadata` (`tool/plugin/shell.ts:120-150`,
  `shell/parse.ts`, `shell/scan.ts`). The shell tool also accepts a `workdir`
  that becomes the command's cwd.
- `external_directory` asks carry only `DIR/*` resources and, except for
  `patch`, no metadata (`file-access.ts`). The only link to the originating
  tool and its input is `source = { type: "tool", messageID, id }`, where `id`
  is the tool-call ID.
- The edit family (`edit`, `write`, `patch`) now always asks
  `external_directory` for an external target **before** the `edit` ask, so
  ADR-0005's scratch-edit allowance is unreachable unless the write-origin
  directory ask is answered too.
- `edit` resources are literal paths, relative to the location directory when
  internal and absolute when external; `patch` may carry several.

- The shell tool's interpreter is chosen from the config `shell` key, else
  `$SHELL` (fish and nu are excluded), else a platform fallback: `/bin/zsh` on
  darwin; elsewhere `bash` from `PATH`, else `/bin/sh` (`shell/select.ts`). A
  configured interpreter that is not executable silently takes the same
  fallback. It runs `<shell> -c <command>`, so on a default macOS setup commands
  execute under **zsh**, not Bash. Probing the current
  analyzer shows this is a real fail-open rather than a cosmetic mismatch.
  zsh expands an unquoted `=word` to the full path of command `word`, while
  Bash reads it as a literal relative file. As a result, `rm -f =node`,
  `chmod 777 =node`, `sed -i s/a/b/ =npm` and `echo x > =npm` are all approved
  as workspace-local operations, but under zsh they would modify executables
  on `PATH`. The zsh constructs that execute code (glob qualifiers
  `*(e:…:)`, `=(…)`, `${(e)…}`) already ask.

- **The default agent rules never ask for `shell` or `edit`.** Every agent
  starts from `Agent.Info.default`, whose first rule is
  `{ action: "*", resource: "*", effect: "allow" }`, followed only by
  `external_directory: * → ask` and `.env` read rules
  (`schema/src/agent.ts:46-52`, `core/src/agent.ts:75-81`). `Permission.evaluate`
  takes the last matching rule (`findLast`), so `shell` and `edit` resolve to
  `allow`, and the evaluate hook sees `effect: "allow"`. Of the built-in agents,
  only `build` and `general` keep that allow-all baseline for `shell`/`edit`:
  - `plan` appends `edit: * → deny` (except its plan directory);
  - `explore`, `compaction`, `title` and `summary` append `*: * → deny`
    (`plugin/agent.ts`, `plugin/plan.ts`).

  User configuration adds rules **after** the built-in ones. Top-level
  `permissions` are appended to **every** agent, while `agents.<id>.permissions`
  are appended to that agent only (`config/plugin/agent.ts:83-122`).

Sentinel therefore cannot see the command it must judge, cannot tell which
tool raised a directory ask, has no reply route to use, and cannot assume the
command runs under the Bash grammar it analyzes. Under the default agent
rules it never even receives an `ask` for `shell` or `edit`. On 2.x it is
inert.

## Why an extension is insufficient

No profile can supply the missing command text or origin. The changes are to
the permission-gate boundary (§6), the source of the effective cwd (§3), and
the trust model (§2): Sentinel would begin trusting a correlation between two
engine hooks and would answer a write-origin directory ask. §8 classifies all
of these as architectural.

## Affected contract

- §2 trust model:
  - new host-correlation trust boundary (below);
  - engine resource formats become verified input shapes;
  - the executing interpreter becomes an explicit precondition: only Bash
    execution is analyzed (dialect gate, §9 below);
  - an engine-side `ask` baseline for `shell` and `edit` becomes an explicit
    deployment precondition (§10 below). Sentinel only ever narrows an existing
    `ask`, so without that baseline it has nothing to decide.
- §3 effective cwd, rule 1: "OpenCode-provided session cwd" is clarified to
  "the cwd OpenCode supplies for this invocation".
- §3 pipeline epilogue: "An allow result replies `once`" becomes "An allow
  result sets the in-band effect to `allow`".
- §6 permission gates: `bash` is renamed `shell`; `external_directory` origin
  is identified by tool-call correlation instead of payload shape; write-origin
  directory asks join the shared path table; the `permission.v2.asked`
  sentence is removed.
- ADR-0003: its origin-identification mechanism is superseded; its read rule
  stands unchanged.
- ADR-0005 §3: the write-origin column becomes live.
- Unchanged: product invariants, decision units, fact kinds, the three
  situations and their precedence, red lines, structural coverage, and
  aggregation.

## Alternatives

1. **Leave 2.x unsupported.** Keeps the model intact but abandons the product
   on the only engine line still developed. Rejected by the maintainer: no
   1.x compatibility is required, and a full move to 2.x is wanted.
2. **Keep the 1.x out-of-band shape on 2.x.** Subscribe to `permission.asked`
   through `ctx.event` and answer with `ctx.permission.reply`. It still lacks
   the command text and origin, so correlation is needed anyway, and it
   reintroduces the human/plugin reply race and the transport fallbacks.
   Strictly worse than an in-band decision. Rejected.
3. **Wrap or replace the engine's `shell` and edit tools** via
   `ctx.tool.transform` to see input and context directly. This makes Sentinel
   own engine tool implementations that change on every upgrade, and puts
   execution concerns into an adapter that must contain no command semantics.
   Rejected.
4. **Capture at `shell` `create.before`.** This sees the final command and cwd
   after other plugins, but the event has no session or call identity, so
   concurrent shell calls cannot be told apart safely. Rejected.
5. **This ADR:** an in-band `permission.evaluate` verdict, with origin and input
   recovered by tool-call correlation and bound back to the request's own
   resources.

The alternatives for establishing the `ask` baseline are weighed separately in
§10.

## Decision

### 1. Host contract

- Default export: `Plugin.define({ id: "opencode-bash-sentinel", setup })`
  from `@opencode/plugin` (Promise API). Options are read from `ctx.options`
  with the existing keys and semantics.
- Workspace (containment boundary) is `ctx.location.project.directory`. If that
  is the filesystem root, use `ctx.location.directory` instead; this mirrors
  the engine's own internal/external split in `FileAccess.resolve`.
- The session default cwd is `ctx.location.directory`.
- The policy context, including the ADR-0001 baseline, is created once per
  plugin setup. Per-call contexts are derived as `{ ...ctx, cwd }`, so the
  baseline is never re-captured.

### 2. In-band verdict

Sentinel registers `ctx.permission.hook("evaluate", …)`. The hook:

1. acts only when `event.effect === "ask"`:
   - an arriving `allow` is never modified. It is only reported by the
     baseline detection (§11);
   - configured `deny` rules short-circuit inside the engine before the hook
     runs (`denied()` precedes `hooks.trigger`), so Sentinel never observes
     them;
   - a `deny` set by another evaluate hook, such as the built-in
     `opencode.config.policy` plugin, may or may not be visible to Sentinel
     depending on hook order. Either way it is never changed, because only an
     `ask` is ever rewritten;
2. may change `effect` only from `ask` to `allow`, and only when every resource
   of the request passes the gate rule below;
3. never throws. The Promise adapter converts a rejection into an engine
   defect that fails the tool call, so every callback is wrapped and any
   exception leaves `effect` untouched;
4. never writes `message`.

### 3. Tool-call correlation

Sentinel registers `ctx.tool.hook("execute.before", …)` and records
`{ tool, input }` for the consumed tools only. The record is keyed by
`(sessionID, id)` and deleted in `execute.after`.

- The consumed tool catalogue is finite: `shell`, `read`, `glob`, `grep`,
  `edit`, `write`, `patch`. All are `codemode: false` in 2.0.18, so one call ID
  maps to exactly one tool invocation.
- A permission request is correlated only when `source.type === "tool"` and a
  record with the same `sessionID` and `source.id` exists.
- A second `execute.before` for an existing key poisons that key until
  `execute.after`.
- The map is bounded at 256 entries. On overflow the oldest entry is evicted,
  which makes its call fail closed.
- The recorded `input` is a snapshot of the fields the gate rule reads (a
  string copy of `command`, `workdir`, `path`), not a live reference.

### 4. Gate mapping

Paths are resolved lexically with the engine's rule: expand `~` / `~/`, then
`path.resolve(base, p)`. `base` is the location directory unless stated.
"Binding" is a check that the correlated input actually explains the
request's resources; a failed binding leaves `ask`.

| action | correlated tool | analyzed target | binding | rule |
| --- | --- | --- | --- | --- |
| `shell` | `shell` | full `command`, cwd = resolved `workdir` or the location directory | non-empty `resources`, each a verbatim substring of `command` | complete Bash policy (gate `shell`) |
| `external_directory` | `shell` | same as above | enforced by the `shell` request that follows (§Fail-closed) | complete Bash policy (gate `external_directory`) |
| `external_directory` | `read`, `glob`, `grep` | resolved `input.path` (`glob`/`grep`: `"."` when absent) | exactly one resource, equal to `T/*` or `dirname(T)/*` | ADR-0003 read rule via `sensitiveVerdict(T)` |
| `external_directory` | `write`, `edit` | resolved `input.path` | resources equal `[dirname(T)/*]` | `sensitiveVerdict(T)` first, then `scratchMutationVerdict(T)` |
| `external_directory` | `patch` | `metadata.filepath` (engine-resolved, absolute) | resources equal `[dirname(T)/*]` and `metadata.parentDir === dirname(T)` | as `write` |
| `edit` | any or none | each resource resolved | every resource non-empty and free of glob metacharacters | ADR-0005 edit rule, per resource; all must allow |
| anything else | — | — | — | untouched |

Notes:

- The `glob`/`grep` rule is **target-only**, exactly as for Bash: `rg foo ~`,
  `ls ~` and `find ~ -name x` allow today, while `rg foo ~/.ssh` asks. A rule
  that asks when a sensitive root lies *below* a searched directory would
  break ADR-0005's "same semantics, same verdict" contract. It is recorded as
  a possible future change for both gates together, not part of this ADR.
- The `edit` gate needs no correlation. Its resources are the concrete targets
  and origin does not change the rule.
- Both 2.0.18 shell scanners (the tree-sitter default and the experimental
  portable scanner) produce resources that are trimmed slices of the command,
  so the substring binding holds for either.

### 5. Effective cwd from `workdir`

The effective-cwd invariant keeps its structure. The default cwd is the cwd
OpenCode supplies for the invocation: the `shell` tool's resolved `workdir`,
else the location directory. The only derived transition is still
`cd LITERAL_DIR && COMMAND`, applied on top of that default. The workspace root
remains a separate containment boundary.

### 6. Write-origin directory asks (decision point 3, option b)

The write-origin rows above answer the `external_directory` half of an
external `write`/`edit`/`patch` with the ADR-0005 mutation rule:

- sensitive targets ask;
- strict scratch descendants allow;
- scratch roots themselves ask;
- every other external target asks.

Together with the unchanged edit gate, a scratch write now passes both prompts,
matching `cat > /tmp/x`. This is the scope ADR-0005 §3 accepted and deferred.

### 7. Advisory features

- **Guidance:** `ctx.session.hook("context", e => e.system.push({ type: "text", text }))`.
  The engine triggers `context` only for primary agent requests (compaction,
  title and generate have their own hooks), so no session filter is needed.
  Guidance stays fail-open advisory.
- **Alerts:**
  - fire whenever the evaluate hook leaves `ask` on a `shell`, `edit` or
    `external_directory` request. This includes `external_directory` asks
    Sentinel cannot correlate (for example from a tool outside the catalogue):
    an alert announces a prompt waiting for the user, whoever left it
    unanswered. Other actions (such as `webfetch`) are not Sentinel's gates
    and never alert;
  - clear on `permission.replied` from `ctx.event.subscribe`.
- **Audit:** the log format is unchanged, except the gate name `bash` becomes
  `shell`. Correlation misses and binding failures are logged with a reason
  (`uncorrelated`, `binding mismatch`), so engine drift stays visible. Requests
  that arrive already allowed are reported as described in §11.

### 8. New trust boundary: host correlation

Sentinel trusts that the tool input it observes in `execute.before` is the
input the tool executes. Hook order among plugins, including the engine's own
`tool-input-repair`, is a product of registration order, not a contract. The
argument below therefore holds whichever hooks run before or after Sentinel.
Any of them may rewrite tool input, tool name, or the shell invocation in
`shell` `create.before`:

- rewrites of **command text** are caught by the substring binding. A rewrite
  seen by Sentinel is simply what it analyzes; one made after Sentinel fails
  the binding;
- rewrites of a **path input** fail the `DIR/*` binding;
- rewrites of **cwd, environment, or tool routing** by other plugins are not
  detected. They are accepted like other tool configuration (§2): installed
  plugins are trusted code.

### 9. Dialect gate: approve only Bash execution

Sentinel's parser and profiles define Bash semantics. The `shell` gate, and
`external_directory` asks correlated to a `shell` call, may therefore allow
only when the invocation is observed to run under Bash.

- **Observation.** Sentinel registers `ctx.shell.hook("create.before", …)`.
  For each invocation it records `{ command, interpreter }` in a bounded
  multiset (256 entries, oldest evicted). `interpreter` is
  `path.basename(invocation.shell)`. In 2.0.18 this hook fires inside
  `Shell.create` immediately before the tool's `prepare`, which raises both
  permission requests. The observation therefore always precedes the
  evaluation of the same call.
- **Matching.** The event has no session or call identity, so it is matched to
  a correlated `shell` call by exact command text.
- **Rule.** Allowing is possible only when at least one observation exists
  whose `command` equals the correlated `input.command`, and **every** such
  observation has interpreter `bash`.
  - Identical commands running concurrently under different interpreters
    therefore ask.
  - A command rewritten before Sentinel observed it also asks (no match).
  - `sh`, `zsh`, `dash`, `ksh`, `fish`, `nu`, PowerShell and unknown names
    all ask.
- **Cleanup.** One matching observation is removed at the `shell` call's
  `execute.after`.
- **Scope.** The gate never produces an allow on its own. It is an extra
  precondition in front of the complete Bash policy.

Setup requirement: users on a non-Bash login shell configure
`"shell": "<path to bash>"` in their OpenCode config. Without it, every
`shell` request that reaches Sentinel as `ask` keeps asking. That is safe, but
Sentinel gives no benefit.

Trust boundaries recorded with the gate:

- **Name only.** The interpreter is identified by executable name. A file
  named `bash` that is not Bash is not detected, consistent with ambient
  `PATH` not being resolved (§2).
- **Bash version.** Version differences are accepted. macOS `/bin/bash` 3.2
  lacks some 4.x syntax (for example `&>>` and `|&`), so a command the parser
  reads with 4.x semantics may be split differently by 3.2. README recommends
  Bash ≥ 4.
- **Startup files and `set` options.** Startup files (`$BASH_ENV`) and `set`
  options are part of the environment and are not modeled (§2).
- **zsh support.** Supporting zsh execution would require a separate ADR that
  recognizes zsh-specific expansion (`=word`, glob qualifiers, `~` forms,
  `setopt` effects) and fails closed on it.

### 10. Ask baseline: per-agent configuration (deployment precondition)

Sentinel reduces prompts; it does not create them. It is effective only for
agents whose `shell` and `edit` requests reach the evaluate hook as `ask`.
Under the 2.0.18 defaults that is no agent (Problem). The baseline is
established by **user configuration, per agent**:

```jsonc
"agents": {
  "build":   { "permissions": [
    { "action": "shell", "resource": "*", "effect": "ask" },
    { "action": "edit",  "resource": "*", "effect": "ask" } ] },
  "general": { "permissions": [
    { "action": "shell", "resource": "*", "effect": "ask" },
    { "action": "edit",  "resource": "*", "effect": "ask" } ] }
}
```

- These rules are appended after the agent's built-in `*: * → allow`, so they
  win under `findLast`. More specific rules the user adds after them (for
  example `shell` `git *` → `allow`) still win in turn.
- `build` and `general` are the only built-in agents with an allow-all
  `shell`/`edit` baseline. Custom agents that inherit the default rules need
  the same two rules.
- `external_directory` already asks by default and needs no configuration.

The baseline must **not** be written as top-level `permissions`. Those are
appended after every agent's built-in rules, so `edit → ask` would override
`plan`'s `edit → deny` and `shell → ask` would override `explore`'s
`* → deny`. Sentinel would then turn those asks into allows, widening agents
designed to be read-only. The per-agent form is required for exactly this
reason.

The same trap applies to legacy keys that v2 migrates silently. A v1-style
`"permission"` block, for example `{ "bash": { "*": "ask" }, "edit": … }`, and
a v1 `"tools"` block are both converted into **top-level** `permissions`, with
`bash` renamed to `shell` and `write`/`patch` renamed to `edit`
(`config/normalize.ts:179-182`, `v1/config/migrate.ts:117-121`). They must be
removed from the configuration, not kept alongside the per-agent baseline.

Alternatives considered for the baseline:

- **Top-level `permissions`:** the simplest configuration, but it widens
  `plan` and `explore` as described above. Rejected.
- **Sentinel installs the baseline itself** through `ctx.agent.transform`, by
  inserting `ask` directly after a blanket `*: * → allow`. This requires no
  user configuration, but it silently rewrites the engine's permission posture
  and depends on transform ordering between built-in, configuration and user
  plugins. Rejected by the maintainer in favour of explicit, visible
  configuration.
- **Per-agent configuration (chosen):** controllable and visible. Its worst
  case is safe: a missing baseline leaves the engine default in force, and
  Sentinel is simply never consulted. That failure mode is made visible by
  §11.

Precedence the baseline cannot override, stated explicitly:

- Session-level permissions merge after the agent rules.
- Rules saved through an "always" reply are merged after all configured rules
  (`permission.ts:176`).

Either may turn a later `shell` or `edit` request into an arriving `allow`,
which bypasses Sentinel by design. The user granted it.

### 11. Baseline detection (advisory)

When a request on a consumed gate (`shell`, `edit`, or a correlated
`external_directory`) arrives at the evaluate hook with `effect: "allow"`,
Sentinel leaves it unchanged and:

- writes an audit line with action `engine-allowed`, recording the gate, the
  agent (`event.agent`, or `unknown`) and the analyzable input, when audit is
  enabled;
- for `shell` and `edit` only, emits one warning per `(agent, action)` pair
  for the plugin instance's lifetime. The warning states that some requests
  arrive already allowed; if that is not due to the user's own specific allow
  rules or saved "always" grants, the per-agent `ask` baseline (§10) is
  missing. An arriving `allow` on `external_directory` is audited but not
  warned about. The engine's default rules already allow its own data, tool
  output, temp and config directories, so an allowed directory ask is normal
  and does not indicate a missing baseline.

Detection only observes the evaluate event. It never modifies rules or
effects, and it does not depend on transform or hook order. It is advisory: a
failure inside it is swallowed like any other hook exception.

## Complexity bound

- **New state:**
  - one map of at most 256 correlation records per plugin instance;
  - one multiset of at most 256 interpreter observations;
  - one set of warned `(agent, action)` pairs, bounded by the number of agents
    times two;
  - no persistence.
- **New work per request:** O(|resources| × |command|) substring checks, or a
  constant number of lexical path comparisons.
- **Unchanged:** no new decision-unit or fact kinds, no aggregation contact,
  no filesystem queries, no shell or order simulation.
- **Removed:** reply transport, transport probe, auth headers, and client
  fetch discovery.

## Fail-closed behavior

- Missing, poisoned or evicted correlation, a non-`tool` source, a session
  mismatch, or a tool outside the catalogue → `ask`.
- Binding mismatch, including resource-format drift in a future engine →
  `ask`, audited.
- Interpreter not observed, ambiguous, or not `bash` → `ask` on the `shell`
  gate and on shell-origin `external_directory` asks, audited as
  `dialect: <name>`. This covers a missing `shell` config, a configured Bash
  that has disappeared (the engine silently falls back to the platform default:
  `/bin/zsh` on darwin, `bash` or `/bin/sh` elsewhere), and another plugin
  swapping the interpreter before Sentinel observes it.
- Missing `ask` baseline → requests arrive as `allow` and stay `allow`. Sentinel
  adds no approval of its own, and §11 reports the condition.
- Empty, dynamic, glob-shaped, or unresolvable paths → `ask`.
- Any exception inside a hook → `effect` unchanged. It is `ask` whenever
  Sentinel could have acted.
- Shell-origin `external_directory` approval does not run anything by itself.
  The same call's `shell` request still needs the binding check and the
  complete policy. The only exception is a command made up solely of
  directory changes, where the engine raises no `shell` request. The complete
  Bash policy allows only a literal `cd DIR` there (`pushd` and dynamic forms
  ask), and that form executes nothing else.
- Plugin reload clears the map. In-flight calls then ask.

## Cross-model consistency

- Situations, red lines, structural coverage, unit composition, stability
  conflicts and aggregation are untouched. Both command gates still use the
  one complete Bash policy entry point.
- `workdir` only changes which directory is the default effective cwd. Every
  cwd rule in §3 applies unchanged on top of it.
- The ADR-0005 verdict matrix keeps its full row set and gains a live
  write-origin column. Verdicts apply to requests that reach Sentinel as `ask`
  (§10):

| Resolved path | Bash read | Bash mutate | read-origin ext. ask | edit gate | write-origin ext. ask |
| --- | --- | --- | --- | --- | --- |
| in-workspace file | allow | allow | allow | allow | n/a |
| in-workspace `.git` file | allow | ask | allow | ask | n/a |
| scratch strict descendant | allow | allow | allow | allow | **allow** (new) |
| scratch `.git` file | allow | allow | allow | allow | **allow** (new) |
| scratch root itself | allow | ask | allow | ask | ask |
| sensitive root | ask | ask | ask | ask | ask |
| `/etc` non-sensitive file | allow | ask | allow | ask | ask |
| `$HOME` ordinary file | allow | ask | allow | ask | ask |

## Counterexamples and tests

These use a fake Promise `ctx` that drives `execute.before`,
`permission.evaluate` and `execute.after` in order.

**Positive cases**
- `shell` `git status` → `allow`.
- `shell` with `workdir: "sub"` and `rm tmp.txt` resolves inside `sub`.
- Read-origin external ask for `~/.config/x` → `allow`.
- `write /tmp/s/f` → both its directory ask and its edit ask allow.
- `patch` with two scratch targets → each directory ask allows.

**Adjacent rejected cases**
- `workdir` pointing outside the workspace combined with a mutation → `ask`.
- `write /tmp` (scratch root) → `ask`.
- `write ~/.ssh/config` → `ask`.
- `glob` with `path: "~/.ssh"` → `ask`.
- `edit` with any resource outside workspace and scratch → `ask`.

**Adversarial cases**
- Command rewritten after capture (resources not substrings) → `ask`.
- Resource `DIR/*` not matching the correlated path → `ask`.
- Duplicate call ID → `ask`.
- `source.id` from another session → `ask`.
- Pre-set `deny` stays `deny`.
- Pre-set `allow` stays `allow`, including for a command Sentinel would ask
  on, such as `cat ~/.ssh/id_rsa`.
- Baseline detection:
  - an arriving `allow` on `shell` or `edit` writes `engine-allowed` to the
    audit log;
  - repeated arrivals for the same `(agent, action)` warn only once;
  - a different agent warns separately;
  - an arriving `allow` on `external_directory` is audited but does not warn;
  - an exception in detection leaves `effect` unchanged.
- Callback exception → `effect` unchanged, and no rejection escapes.
- Map overflow evicts the oldest record → that call asks.
- Dialect gate:
  - `rm -f =node` observed under `zsh` → `ask`;
  - the same command under `bash` → policy verdict;
  - no `create.before` observation → `ask`;
  - the same command text observed under both `bash` and `zsh` → `ask`;
  - `/bin/sh` → `ask`.

**Architecture-contract regressions**
- The `shell` and `external_directory` gates share one policy function.
- No gate turns `ask` into `allow` without correlation, except `edit`.
- The cross-gate matrix above holds, over the full ADR-0005 row set.

**Engine verification (manual)** against a real 2.0.18 build:
- with the default configuration, `shell` and `edit` requests from `build`
  arrive at the hook as `allow`, and the §11 warning fires;
- with the §10 per-agent baseline, `build` and `general` requests arrive as
  `ask`; `plan` edits and `explore` shell calls are still denied by the
  engine (they never reach the hook);
- call-ID equality between `execute.before` and `source.id`;
- `context` hook invocation;
- `create.before` firing before the same call's permission evaluation, with
  `invocation.shell` equal to the configured interpreter;
- with `"shell": "/opt/homebrew/bin/bash"` configured,
  `echo "0=$0 bash=$BASH_VERSION zsh=$ZSH_VERSION"` run by the agent reports
  Bash. (`ps -o comm= -p $$` is unreliable: `bash -c` execs a lone simple
  command, so it reports `ps`.) Without the setting, the zsh default is
  observed and every `shell` request asks.

## Migration and compatibility

- `@opencode-ai/plugin` is replaced by `@opencode/plugin@2.0.18`;
  `engines.opencode` becomes `>=2.0.18 <3.0.0`. 1.x support is removed
  entirely.
- User configuration moves to the 2.x plugin entry form
  `{ "package": "opencode-bash-sentinel", "options": { … } }`. Option keys and
  meanings are unchanged.
- `PolicyGate` becomes `"shell" | "external_directory"`. This is a rename with
  no verdict change.
- Audit consumers see `gate: "shell"` instead of `"bash"`.
- **Deployment precondition:** the per-agent `ask` baseline (§10) must be
  configured. Without it Sentinel is never consulted for `shell` or `edit`,
  and the engine default (allow-all) applies unchanged.
- **Behavior changes,** relative to a configuration with the §10 baseline
  (where every `shell`/`edit` request would otherwise prompt):
  - scratch writes through the edit family stop prompting at the directory
    ask;
  - commands using `workdir` are judged from that directory, so some forms
    now ask;
  - `shell` approvals require Bash execution. Users whose `$SHELL` is not
    Bash must set the OpenCode `shell` config key, or every command asks.

## Documentation updates

- `ARCHITECTURE.md`:
  - §2: add the host-correlation trust boundary and the Bash-execution
    precondition (dialect gate).
  - §3: clarify the cwd default; replace "replies `once`" with the in-band
    `allow` effect.
  - §6: rename `bash` to `shell`; describe correlation-based origin
    identification and the write-origin rule; drop the `permission.v2.asked`
    sentence.
- `DEVELOPMENT.md`: rewrite "OpenCode integration" against 2.0.18 (hook names,
  resource formats, correlation, binding, verification duties); update the
  `src/plugin.ts` ownership line.
- `README.md`:
  - setup: the 2.x config form and the engine range;
  - the **required** per-agent `ask` baseline (§10), with an explicit warning
    not to use top-level `permissions`, and to remove any legacy v1
    `"permission"` or `"tools"` block, which v2 migrates into top-level
    rules;
  - the **required** `"shell"` setting for non-Bash login shells (recommend
    Bash ≥ 4, for example Homebrew's `/opt/homebrew/bin/bash` on macOS);
  - the `engine-allowed` warning and what it means;
  - the edit and outside-workspace behavior sections.
- ADR-0003 and ADR-0005: add a pointer to this record.
- Tests:
  - rewrite `test/plugin.test.ts` for the evaluate/correlation model;
  - update the e2e mock;
  - add the matrix rows to the cross-gate contract block;
  - profile tests are unaffected.

## Approval

- 2026-09-29, decision point 3: the maintainer chose option (b). Write-origin
  `external_directory` asks join the shared ADR-0005 mutation table (§6
  above).
- 2026-09-29, dialect gate: the maintainer chose "approve only Bash
  execution" (§9) over treating zsh as a trust boundary.
- 2026-09-29, ask baseline: after a review found that the 2.0.18 default rules
  are allow-all for `shell` and `edit`, the maintainer chose explicit
  per-agent configuration (§10). This was preferred over Sentinel installing
  the baseline itself, and was paired with advisory baseline detection (§11).
- 2026-09-29: the maintainer approved the ADR as a whole and committed it.
  Implementation followed the same day.
