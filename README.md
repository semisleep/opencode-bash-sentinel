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

## How it works

The plugin enforces one principle over every bash command, external-directory request, and file edit:

| | Inside your workspace | Outside your workspace |
|---|---|---|
| **Read** | runs silently | runs silently |
| **Write** | runs silently | **you get the native approval dialog** |

"Workspace" is your project directory (git worktree when available). Writes to `.git`, workspace/home/system root targets (`rm -rf ./` on the workspace itself, `~`, `/`), and unresolvable targets (`rm $TARGET`) always escalate — fail-safe.

On top of the path policy, the ported Kimi dangerous-command rules still apply everywhere: `sudo`/`env`/`sh -c`/`busybox` wrappers are unwrapped recursively, `shutdown`/`mkfs*`/`dd`-to-raw-devices and friends escalate regardless of path, and commands the analyzer cannot prove safe (un-literal command names, opaque nested-shell payloads, parser timeouts) escalate instead of guessing.

## What gets escalated (examples)

- Any write outside the workspace: `rm ~/.zshrc`, `sed -i s/a/b/ /etc/hosts`, `echo x > /tmp/out`, `cp proj /usr/local/bin/x`, `tee /tmp/log`, `rsync src/ /backup/`, `install`, `ln`, `truncate`, `shred`, `dd of=/tmp/img`
- Redirects (`>`, `>>`, `2>`, `&>`) whose target is outside the workspace, unresolvable (`> $OUT`), or inside `.git`
- Escape hatches: `find ... -delete` / `-exec`, `xargs rm`, inline-code interpreters (`python -c`, `node -e`, `ruby -e`, `php -r`, any `osascript`)
- `cd` outside the workspace followed by a relative write (`cd /tmp && echo x > f`)
- Catastrophic targets even inside the workspace: the workspace root itself, `~`, `/`, and `.git` paths
- The upstream Kimi dangerous list: `sudo rm -rf ...`, `shutdown`, `reboot`, `mkfs*`, `init 0/6`, `systemctl poweroff`, `dd of=/dev/sda`, ...

## What runs silently (examples)

`git status`, `ls -la`, `rg foo src/`, `npm test`, `cat /etc/hosts`, `cd /tmp && ls`, `rm -rf build/`, `echo x > out.txt`, `sed -i s/a/b/ src/file.ts`, edits to any file inside the workspace — no keystrokes.

If the native dialog asks about an external write and you approve it, the follow-up bash permission for the same command is approved automatically (no double-prompting).

## Installation

Verified against opencode 1.18.29 (release binary). Requires opencode >= 1.18.0.

Add to your config — a project's `opencode.json`, or the global `~/.config/opencode/opencode.json` (`.jsonc` also works):

**From a local checkout** (works today, changes take effect on next launch):

```json
{
  "plugin": ["/absolute/path/to/opencode-bash-sentinel"],
  "permission": {
    "bash": { "*": "ask" },
    "edit": { "*": "ask" }
  }
}
```

**From npm** (once published):

```json
{
  "plugin": ["opencode-bash-sentinel"],
  "permission": {
    "bash": { "*": "ask" },
    "edit": { "*": "ask" }
  }
}
```

The `permission` entries route every bash command and file edit through the approval flow — the plugin then auto-replies to the safe ones in milliseconds (same mechanism OpenCode's own auto mode uses), so you only see a dialog when it matters. `edit` routing is optional but recommended: without it, in-workspace edits follow your normal opencode rules. Project-level `plugin`/`permission` config merges with the global config.

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
| `audit` | `false` | Append one JSONL line per decision (`timestamp`, `gate`, `command`, `verdict`, `action`) |
| `logPath` | `~/.local/share/opencode/bash-sentinel-audit.jsonl` | Where the audit log is written |
| `upstream` | `false` | Revert to the verbatim Kimi policy (workspace path rules, external-read approval, and the edit gate are all disabled) |

## Behavior notes

- **`deny` rules always win.** Commands matched by a `deny` rule fail before the plugin is ever consulted.
- **`"always allow" bypasses the plugin** for the rest of the session. If you answer "always" on a dialog, that pattern is approved without analysis afterwards.
- **Known blind spots** (fail-open, by pragmatic design): commands that write through channels neither opencode's external-directory scan nor the write-command table sees — e.g. `awk '... > "file"'`, `tar -C`, package managers with `--prefix` — and symlink escapes (a literal path inside the workspace that is a symlink to outside). The audit log exists partly to spot these in practice.
- **Path comparison is literal and case-sensitive**; macOS case-insensitive filesystems are not modeled.
- **`pwsh`/`cmd` tools are out of scope** (bash analysis only).
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
