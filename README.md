# opencode-bash-sentinel

AST-based bash command gate for [OpenCode](https://opencode.ai) — silently auto-approves provably safe commands, and escalates dangerous or un-analyzable ones to the native approval dialog.

The analysis engine is ported from Moonshot AI's open-source **Kimi Code** CLI (MIT): a pure-TypeScript bash parser (`tree-sitter-bash`-compatible syntax trees) plus its `dangerous-command-ask` policy, wrapped as an OpenCode plugin.

> No LLM calls, no API cost — pure deterministic syntax-tree analysis, runs offline.

---

## Why

OpenCode's built-in bash permissions offer two extremes:

| Option | Behavior | Weakness |
|---|---|---|
| Static rules (`"bash": {"git status*": "allow"}`) | String-prefix/wildcard matching | Not semantic: unaware of wrappers (`sudo`, `env`, `sh -c`), pipes/compounds, or variable expansion. Fails open on unknown variants. |
| `--auto` mode | Approve everything not denied | No risk analysis — a typo'd `rm -rf` sails through. |

This plugin is the middle ground Kimi Code ships by default: parse the command into a syntax tree, classify it deterministically, auto-approve the provably-safe ones, and stop everything dangerous or opaque at the native dialog. The failure direction is **fail-safe**: risky constructs with un-resolvable operands (variables, globs, command substitution), unknown command names, malformed input, and parser timeouts are escalated to a human, never silently approved.

## What gets escalated to the human

- **Privilege/launch wrappers**: `sudo`, `doas`, `env`, `command`, `exec`, `nohup`, `builtin`, `nice` — unwrapped and the inner command analyzed recursively
- **Nested shells**: `sh`/`bash`/`zsh -c '...'`, `eval`, `busybox <applet>` — payload analyzed recursively (max depth 4)
- **Dangerous commands**: `shutdown`, `reboot`, `halt`, `poweroff`, `mkfs*`, `wipefs`, `diskpart`, `format`, `init 0/6`, `systemctl poweroff/reboot/...`, `dd` writing to raw devices (`/dev/sda`, ...; `/dev/null` etc. are allowed), `rm` with both recursive and force flags — **any** `rm -rf`, regardless of target
- **Opaque input on risky constructs**: when the command itself is one of the above (a wrapper, nested shell, `eval`, `busybox`, `init`, `systemctl`, `dd`, `rm`) and its operands contain variables (`$`), globs (`*?[]`), `~`, or command substitution, it escalates instead of guessing
- **Un-analyzable command names or shell payloads**: e.g. `$CMD --force`, `bash -c "echo $HOME"`, syntax errors, or parser timeouts
- Command names are normalized: `/bin/rm` → `rm`, `RM` → `rm`, `rm.exe` → `rm`
- Pipes (`a | b`) and sequences (`a && b; c`) are fully covered — every segment is analyzed, including commands inside `$(...)` substitutions

Everything else (e.g. `git status`, `ls -la`, `rg foo src/`, `npm test`) runs without a keystroke. Note that by upstream design, a **generic** command with variable/glob operands (`cat $FILE`, `ls *.md`) is approved — the fail-safe escalation applies to the risky constructs listed above, and to command names/payloads that cannot be resolved.

## Installation

Verified against opencode 1.18.29 (release binary). Requires opencode >= 1.18.0.

Add to your config — a project's `opencode.json`, or the global `~/.config/opencode/opencode.json` (`.jsonc` also works):

**From a local checkout** (works today, changes take effect on next launch):

```json
{
  "plugin": ["/absolute/path/to/opencode-bash-sentinel"],
  "permission": { "bash": { "*": "ask" } }
}
```

**From npm** (once published):

```json
{
  "plugin": ["opencode-bash-sentinel"],
  "permission": { "bash": { "*": "ask" } }
}
```

The `permission` entry routes every bash command through the approval flow — the plugin then auto-replies to the safe ones in milliseconds (same mechanism OpenCode's own auto mode uses), so you only see a dialog when it matters. Project-level `plugin`/`permission` config merges with the global config.

## Options

```json
{
  "plugin": [
    ["opencode-bash-sentinel", { "audit": true, "logPath": "/tmp/sentinel.jsonl" }]
  ]
}
```

| Option | Default | Description |
|---|---|---|
| `audit` | `false` | Append one JSONL line per decision (`timestamp`, `command`, `verdict`, `action`) |
| `logPath` | `~/.local/share/opencode/bash-sentinel-audit.jsonl` | Where the audit log is written |

## Behavior notes

- **`deny` rules always win.** Commands matched by a `deny` rule fail before the plugin is ever consulted.
- **`"always allow" bypasses the plugin** for the rest of the session. If you answer "always" on a dialog, that pattern is approved without analysis afterwards.
- **`external_directory` prompts are untouched.** OpenCode separately asks when a command touches directories outside your project; this plugin only handles bash command safety, so such commands may still prompt.
- **`--auto` mode makes this plugin moot** — in auto mode the TUI already approves everything.
- Dangerous commands are *escalated*, never blocked: the native dialog still lets you approve them manually.

## Provenance / upstream versions

The ported engine is pinned to these upstream commits (see [DEVELOPMENT.md](DEVELOPMENT.md) for how to refresh them):

| Upstream | Repository | Commit | Date |
|---|---|---|---|
| Kimi Code | https://github.com/MoonshotAI/kimi-code | `f88ed6d45bcf5ea358c173af7a3568b57ba9bd38` | 2026-09-08 |
| OpenCode (integration contract verified against) | https://github.com/anomalyco/opencode | `ecbc6ccac85b3e8087b6445e584318419b9e2b34` (branch `dev`); e2e-tested on release binary 1.18.29 | 2026-09-07 |

## License

MIT. Portions Copyright (c) 2026 Moonshot AI, Inc., adapted from [MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code) (MIT) — see [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md).

## Development

Implementation details, verified integration facts, and the test plan live in [DEVELOPMENT.md](DEVELOPMENT.md).
