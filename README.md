# opencode-bash-sentinel

AST-based bash command gate for [OpenCode](https://opencode.ai) — silently auto-approves commands that satisfy its documented policy and trust model, and escalates dangerous or un-analyzable ones to the native approval dialog.

The analysis engine is ported from Moonshot AI's open-source **Kimi Code** CLI (MIT): a pure-TypeScript bash parser (`tree-sitter-bash`-compatible syntax trees) plus its `dangerous-command-ask` policy, wrapped as an OpenCode plugin.

> No LLM calls, no API cost — pure deterministic syntax-tree analysis, runs offline.

---

## Why

OpenCode's built-in bash permissions offer two extremes:

| Option | Behavior | Weakness |
|---|---|---|
| Static rules (`"bash": {"git status*": "allow"}`) | String-prefix/wildcard matching | Not semantic: unaware of wrappers (`sudo`, `env`, `sh -c`), pipes/compounds, or variable expansion. Fails open on unknown variants. |
| `--auto` mode | Approve everything not denied | No risk analysis — a typo'd `rm -rf` sails through. |

This plugin is the middle ground Kimi Code ships by default: parse the command into a syntax tree, classify it deterministically, auto-approve commands accepted by the policy, and stop recognized dangerous or opaque constructs at the native dialog. The failure direction is **fail-safe for modeled operations**: unresolvable operands on recognized write commands, un-literal command names, opaque nested-shell payloads, malformed input, and parser timeouts are escalated to a human. Literal command names that have no dedicated rule are allowed; see the trust boundary below.

## How it works

The plugin enforces one principle over every bash command, external-directory request, and file edit:

| | Inside your workspace | Outside your workspace |
|---|---|---|
| **Read** | runs silently | runs silently |
| **Write** | runs silently | **you get the native approval dialog** |

"Workspace" is your project directory (git worktree when available). Writes to `.git`, workspace/home/system root targets (`rm -rf ./` on the workspace itself, `~`, `/`), and unresolvable targets (`rm $TARGET`) always escalate — fail-safe.

On top of the path policy, the ported Kimi dangerous-command rules still apply everywhere: `sudo`/`env`/`sh -c`/`busybox` wrappers are unwrapped recursively, `shutdown`/`mkfs*`/`dd`-to-raw-devices and friends escalate regardless of path, and commands the analyzer cannot prove safe (un-literal command names, opaque nested-shell payloads, parser timeouts) escalate instead of guessing.

## What gets escalated (examples)

- Any write outside the workspace: `rm ~/.zshrc`, `sed -i s/a/b/ /etc/hosts`, `echo x > /tmp/out`, `sudo cp proj /usr/local/bin/x`, `env mv proj /tmp/`, `sudo chmod`/`chown`/`mkdir`/`touch` on external paths, `tee /tmp/log`, `rsync src/ /backup/`, `install`, `ln`, `truncate`, `shred`, `dd of=/tmp/img`
- Mutating `git` on another repository: `git -C /elsewhere checkout`, `git --git-dir=...` (read-only subcommands like `git -C /elsewhere log` stay silent)
- Redirects (`>`, `>>`, `2>`, `&>`) whose target is outside the workspace, unresolvable (`> $OUT`), or inside `.git`
- Escape hatches: `find ... -delete` / `-exec`, `xargs rm`, command wrappers (`time rm x`, `timeout 10 rm x`, `watch ...`), inline-code interpreters (`python -c`, `node -e`, `ruby -e`, `php -r`, any `osascript`), pipe-executed shells (`curl ... | sh`), scripts from outside the workspace (`python /tmp/x.py`, `bash /tmp/x.sh`, `source /tmp/env`, heredoc/stdin scripts), remote execution (`ssh host cmd`, `scp`), and `awk` programs using `system()` or file redirection
- `cd` outside the workspace followed by a relative write (`cd /tmp && echo x > f`)
- Catastrophic targets even inside the workspace: the workspace root itself, `~`, `/`, and `.git` paths
- The upstream Kimi dangerous list: `sudo rm -rf ...`, `shutdown`, `reboot`, `mkfs*`, `init 0/6`, `systemctl poweroff`, `dd of=/dev/sda`, ...

## What runs silently (examples)

`git status`, `ls -la`, `rg foo src/`, `npm test`, `cat /etc/hosts`, `cd /tmp && ls`, `rm -rf build/`, `echo x > out.txt`, `sed -i s/a/b/ src/file.ts`, `python script.py` / `bash scripts/build.sh` (workspace scripts), `ssh`-free dev tooling, edits to any file inside the workspace — no keystrokes.

External-directory permission and Bash-risk permission are intentionally independent. A dangerous command that also accesses an external directory may therefore show two dialogs: approval of directory access is not treated as approval of the command's separate Bash risk.

## Trust boundary and limitations

This plugin is a permission heuristic, not a sandbox or a proof of a process's eventual effects. It analyzes the submitted Bash command line; it does not inspect or sandbox the contents of scripts, binaries, package hooks, build tools, or other programs that the command starts.

In particular, workspace scripts such as `python script.py` and `bash scripts/build.sh`, and ordinary development commands such as `npm test` or `make`, are trusted when their command line itself contains no modeled dangerous effect. Such code can still write outside the workspace, delete files, access credentials, or perform network operations internally. Use OS/container sandboxing when the workspace or its executable contents are not trusted.

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
- **Known blind spots** (fail-open, by pragmatic design): literal commands without a dedicated rule, writes performed internally by an allowed script/tool, and command-specific channels neither OpenCode's external-directory scan nor the write-command table sees — e.g. dynamic `awk` redirection targets, `tar -C`, or package managers with `--prefix`.
- **Workspace paths are lexical, not filesystem-canonical.** A literal path inside the workspace that traverses a symlink to an external target can escape the policy. Use a sandbox when this matters.
- **Reads, network access, and data exfiltration are not governed by the write policy.** External reads run silently, and tools such as `curl`, `git push`, or custom CLIs can transmit data.
- **Audit logs contain the complete command text.** When audit mode is enabled, command-line credentials or tokens are written to the configured log path.
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
