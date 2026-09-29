# opencode-bash-sentinel

An AST-based Bash permission helper for [OpenCode](https://opencode.ai). It automatically approves common, positively recognized commands and leaves every unsupported or ambiguous form to OpenCode's native approval dialog.

> Analysis is deterministic, local, and uses no LLM calls.

## Purpose

Sentinel reduces routine permission prompts. Automatically handling roughly 70–80% of ordinary requests is a successful outcome; complete Bash classification is not.

It is not a sandbox and does not prove a process's eventual effects. A harmless but unfamiliar command may still require approval. That is expected fail-closed behavior.

## Policy model

Sentinel parses a Bash source once, accepts only a bounded structural subset, extracts independently evaluated decision units, and requires every unit to allow. Commands are handled in three situations.

### Inside the workspace

Recognized operations whose relevant paths are all inside the workspace are allowed, including ordinary writes and deletion of subpaths, except for three red lines:

1. Directly deleting, removing, or moving away the workspace root requires approval.
2. Directly modifying `.git` through ordinary filesystem operations requires approval.
3. A workspace script requires approval unless its entry file matches the Git baseline captured when Sentinel starts, remains unchanged in the index and worktree, and has no visibly external or ambiguous path argument.

Examples that normally allow:

```bash
rg TODO src/
echo enabled > config/local.env
sed -i 's/old/new/' src/config.ts
rm -rf build/
```

Examples that ask:

```bash
rm -rf .
echo broken > .git/config
./scripts/modified-check
```

The last example asks when that entry file is modified, untracked, committed only after Sentinel started, or otherwise cannot be verified against the captured baseline.

### Outside the workspace

A finite set of recognized read-only forms is allowed. Recognized writes and unsupported forms require approval. Reads of a small, conservative set of sensitive paths (credential and key stores such as `~/.ssh`, `~/.aws`, `~/.gnupg`) instead ask, so an agent cannot silently spill them into the transcript.

There is one exception for writes: recognized mutations targeting a strict descendant of a designated scratch root allow. The default list is the host's system temp directories (`/tmp`, `/private/tmp` on macOS, and the resolved `TMPDIR`); deleting or moving a scratch root itself still asks, and sensitive reads still ask even when the write side is scratch.

```bash
cat /etc/hosts       # allow
ls -la /tmp          # allow
echo x > /tmp/out    # allow (scratch descendant)
rm -rf /tmp/probe    # allow (scratch descendant)
rm -rf /tmp          # ask (scratch root itself)
echo x > /etc/out    # ask
cat ~/.ssh/id_rsa    # ask
```

The sensitive list is best-effort, not a completeness guarantee: an unlisted path keeps the ordinary external-read behavior, and matching is lexical (case-insensitive, like the `.git` rule), so a symlink pointing at a sensitive location is not caught. Extra roots can be added with the `sensitivePaths` option; they only add prompts.

The same lexical caveat applies to scratch roots, and scratch directories are shared and world-writable by convention: the allowance trusts the path spelling, not the filesystem, and everything under a scratch root is treated as ephemeral — including another session's throwaway checkout. Scratch matching is exact-case (`/TMP` is not `/tmp`), so case-varied spellings ask. The `scratchPaths` option replaces the default list (`["/srv/scratch"]`) or disables the feature entirely (`false`); it cannot remove the sensitive-read or scratch-root red lines.

If one recognized command mixes inside and outside targets, the entire command is treated as outside.

### No workspace relationship, or indeterminate

Only exact reviewed profiles allow. These include bounded forms of common informational commands, stdout-only network reads, Git operations, environment assignments, and development workflows. Unknown commands, options, operands, wrappers, or dynamic values ask.

The exact current profiles live in `src/policy/profiles/`, with adjacent behavior specified by `test/profiles/`. The code is intentionally the authoritative catalogue so profile changes do not force this overview to churn.

## Composition and trust boundaries

Sentinel supports a deliberately small Bash composition subset. Every extracted command, redirect, and nested executable unit must allow, and every relevant AST node must be accounted for. Complex control flow, generic wrapper unwrapping, embedded command languages, and incomplete parsing ask.

Analysis observes syntax and a small set of static facts; it does not inspect or constrain opaque runtime behavior. Important accepted limitations include:

- lexical rather than symlink-canonical workspace containment;
- committed scripts, package hooks, build tools, Git hooks, imports, and configuration may have hidden effects;
- an approved `source` file may change later shell interpretation;
- ambient `PATH`, most environment semantics, curl configuration, proxies, and remote side effects are not modeled;
- analysis and execution do not share an atomic filesystem snapshot.

These are trust boundaries, not claims of complete safety.

## File-edit permission

The OpenCode `edit` permission (used by the `edit`, `write` and `patch` tools) follows the same path rules as the Bash gate's write side: ordinary resolved workspace paths allow; in-workspace `.git` paths, sensitive roots, and unresolved paths ask; external edits allow only as strict descendants of a designated scratch root (including their `.git` paths), while scratch roots themselves and every other external path ask. A multi-file `patch` allows only when every file passes. Editing a script is allowed, while later execution is evaluated by the script red line. `scratchPaths: false` disables the scratch allowance for both the Bash and edit gates.

OpenCode asks `external_directory` before an external edit. That directory ask follows the same mutation rule, so a write to a scratch path such as `/tmp/probe/out.txt` passes both prompts, just like `echo x > /tmp/probe/out.txt`.

## OpenCode behavior

Sentinel decides **in-band**: OpenCode calls its `permission.evaluate` hook before showing a dialog, and Sentinel may turn an `ask` into `allow`. It never changes an `allow` or a `deny`, and it never creates a prompt of its own. Anything it does not positively recognize stays `ask`, and the native dialog decides.

- **`shell` and `external_directory`.** The two command gates are independent, but both use the same complete Bash policy. The command is judged from the shell tool's `workdir` when one is given, otherwise from the session directory.
- **External path asks.** Directory asks from the `read`, `glob` and `grep` tools follow the outside-workspace read rule: non-sensitive paths allow and sensitive roots ask. Directory asks from `edit`, `write` and `patch` follow the scratch mutation rule above.
- **Origin identification.** OpenCode's permission request carries neither the command text nor the originating tool. Sentinel recovers both by matching the request to the tool call that raised it, then checks that the tool's input actually explains the request. For example, every command segment OpenCode reports must appear in the captured command. Anything that does not match keeps asking, and with `audit` enabled the reason (`uncorrelated`, `binding mismatch`) is logged, so drift in a future engine is visible rather than silent.
- **Bash only.** Sentinel analyzes Bash syntax, so it only approves commands that OpenCode actually runs under `bash`. Under zsh, `sh` or any other interpreter every shell request keeps asking (audited as `dialect: <name>`). This matters: zsh expands `=node` to the full path of `node`, which Bash would read as a plain file name.
- **What Sentinel never overrides.** OpenCode `deny` rules and organization policies, and grants saved through an "always" reply (they persist per project), take precedence. Requests they cover never reach Sentinel's analysis.
- **`--auto`.** `opencode run --auto` already approves everything not denied and makes Sentinel unnecessary.

## Installation

Verified against OpenCode 2.0.18. Requires OpenCode `>=2.0.18 <3.0.0`; OpenCode 1.x is not supported.

Sentinel needs three things in your OpenCode configuration (for example `~/.config/opencode/opencode.jsonc`):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",

  // 1. Run agent commands under Bash (see "Bash only" above).
  "shell": "/opt/homebrew/bin/bash",

  // 2. Make shell and edit requests ask, per agent.
  "agents": {
    "build":   { "permissions": [
      { "action": "shell", "resource": "*", "effect": "ask" },
      { "action": "edit",  "resource": "*", "effect": "ask" } ] },
    "general": { "permissions": [
      { "action": "shell", "resource": "*", "effect": "ask" },
      { "action": "edit",  "resource": "*", "effect": "ask" } ] }
  },

  // 3. Load the plugin: a local checkout, or "opencode-bash-sentinel" once published.
  "plugins": ["/absolute/path/to/opencode-bash-sentinel"]
}
```

1. **Bash interpreter.** Without `shell`, OpenCode uses your login shell (`$SHELL`) and falls back to `/bin/zsh` on macOS, so Sentinel approves nothing. Bash 4 or newer is recommended; macOS's bundled `/bin/bash` is 3.2. Only the agent's command execution changes. Your interactive terminal keeps its own shell, and the agent inherits the same environment variables either way, because non-interactive `zsh -c` does not read `.zshrc` either.
2. **Per-agent ask baseline.** OpenCode's default agents allow every `shell` and `edit` request without asking. Sentinel only ever turns an `ask` into an `allow`, so without these rules it is never consulted. `build` and `general` are the built-in agents with that allow-all default; add the same two rules to any custom agent that inherits it. `external_directory` already asks by default.
   - **Do not use top-level `permissions` for this.** They are appended to every agent, so `edit → ask` would override the read-only `plan` agent's `edit → deny`, and `shell → ask` would override the `explore` agent's deny-all. Sentinel would then approve what those agents were designed never to do.
   - For the same reason, **remove any OpenCode 1.x `"permission"` or `"tools"` block.** OpenCode 2.x silently migrates them into top-level `permissions`.
   - More specific allow rules you add after the baseline (for example `shell` `git *` → `allow`) keep working and simply bypass Sentinel.
3. **The plugin itself.** It is loaded from source with no build step.

If the baseline is missing, Sentinel prints one warning per agent and permission ("… arrive already allowed …") and, with `audit` enabled, logs `engine-allowed` lines.

## Options

```json
{
  "plugins": [
    { "package": "opencode-bash-sentinel", "options": { "audit": true, "logPath": "/tmp/sentinel.jsonl" } }
  ]
}
```

| Option | Default | Description |
|---|---|---|
| `audit` | `false` | Append one JSONL line per decision |
| `logPath` | `~/.local/share/opencode/bash-sentinel-audit.jsonl` | Audit-log destination |
| `sensitivePaths` | `[]` | Extra sensitive-read roots, unioned with the built-in defaults (additive only) |
| `alert` | `false` | `true`, or `{ "sound": true, "mark": true }` per channel. `sound` also accepts a sound-file path. `mark` colors the iTerm2 tab chrome, shows a blinking red tab dot, and bounces the dock icon once; it clears when the permission is replied. Other terminals ignore the mark sequences |
| `guidance` | built-in text | System-prompt nudge telling the agent to prefer simple literal shell commands over ad-hoc scripts, because unrecognized script execution always prompts. A string replaces the text; `false` disables injection. Advisory only — it never changes a permission verdict |

By default the plugin adds this guidance to the system prompt of every primary agent request (not to title or compaction requests), steering the agent toward command forms the analyzer can positively recognize (fewer prompts, faster progress). Set `"guidance": false` if you do not want a permission plugin touching prompts.

Every audit line carries a `build` field identifying the code that produced it: the plugin's `git rev-parse --short HEAD` captured when OpenCode loaded it, with `+dirty` when engine sources were uncommitted at that moment. OpenCode loads a local plugin directly from source with no build step and watches its files, reloading changed code. The `build` field is how you tell which code produced a given verdict.

## Development and provenance

[ARCHITECTURE.md](ARCHITECTURE.md) is the stable policy constitution. [DEVELOPMENT.md](DEVELOPMENT.md) explains module ownership, extension rules, and verification. `CLAUDE.md` links to `AGENTS.md` so supported agents receive the same project instructions.

The Bash parser was adapted from Moonshot AI's open-source [Kimi Code](https://github.com/MoonshotAI/kimi-code) CLI at commit `f88ed6d45bcf5ea358c173af7a3568b57ba9bd38` under MIT. Sentinel's policy is independent of Kimi's former dangerous-command analyzer.

## License

MIT. Portions Copyright (c) 2026 Moonshot AI, Inc. See [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md).
