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

This plugin parses each command into a syntax tree and applies a positive trust policy. It auto-approves only when every executable is explicitly recognized and every modeled effect satisfies the workspace policy. Unknown commands, untrusted executable paths, opaque constructs, malformed input, and parser failures stay at the native approval dialog. The final decision is **default-deny**: absence of a known danger is not evidence of safety.

## How it works

The plugin enforces one principle over every bash command, external-directory request, and file edit:

| | Inside your workspace | Outside your workspace |
|---|---|---|
| **Recognized read** | runs silently | runs silently |
| **Recognized write** | runs silently | **you get the native approval dialog** |
| **Unknown/unmodeled** | **you get the native approval dialog** | **you get the native approval dialog** |

"Workspace" is your project directory (git worktree when available). Writes to `.git`, workspace/home/system root targets (`rm -rf ./` on the workspace itself, `~`, `/`), and unresolvable targets (`rm $TARGET`) always escalate — fail-safe.

On top of the path policy, the ported Kimi dangerous-command rules still apply everywhere: `sudo`/`env`/`sh -c`/`busybox` wrappers are unwrapped recursively, and `shutdown`/`mkfs*`/`dd`-to-raw-devices and friends escalate regardless of path. The positive trust pass then rejects anything that was not explicitly recognized, including literal but unknown command names.

## What gets escalated (examples)

- Any write outside the workspace: `rm ~/.zshrc`, `sed -i s/a/b/ /etc/hosts`, `echo x > /tmp/out`, `sudo cp proj /usr/local/bin/x`, `env mv proj /tmp/`, `sudo chmod`/`chown`/`mkdir`/`touch` on external paths, `tee /tmp/log`, `rsync src/ /backup/`, `install`, `ln`, `truncate`, `shred`, `dd of=/tmp/img`
- Mutating `git` on another repository: `git -C /elsewhere checkout`, `git --git-dir=...` (read-only subcommands like `git -C /elsewhere log` stay silent)
- Redirects (`>`, `>>`, `2>`, `&>`) whose target is outside the workspace, unresolvable (`> $OUT`), or inside `.git`
- Escape hatches: `find ... -delete` / `-exec`, `xargs rm`, command wrappers (`time rm x`, `timeout 10 rm x`, `watch ...`), inline-code interpreters (`python -c`, `node -e`, `ruby -e`, `php -r`, any `osascript`), pipe-executed shells (`curl ... | sh`), scripts from outside the workspace (`python /tmp/x.py`, `bash /tmp/x.sh`, `source /tmp/env`, heredoc/stdin scripts), remote execution (`ssh host cmd`, `scp`), and `awk` programs using `system()` or file redirection
- `cd` outside the workspace followed by a relative write (`cd /tmp && echo x > f`)
- Sensitive environment assignments that can redirect execution or storage (`GIT_DIR`, `GIT_WORK_TREE`, `HOME`, `PATH`, `BASH_ENV`, `LD_PRELOAD`, ...)
- External-directory requests from commands whose path effects are not explicitly modeled (`curl -o`, `tar -C`, custom CLIs, package managers, ...)
- Unknown commands and executable lookalikes outside the workspace (`custom-cli`, `/tmp/ls`), unrecognized `git` subcommands and remote operations such as `git push`, and environment-prefixed commands whose behavior cannot be proven (`FOO=bar tool`)
- Command-specific output/escape channels such as `find -fprint /tmp/out`, remote `rsync`, `rsync --log-file=/tmp/log`, sed `e`/`w` programs, `rg --pre`, `file --compile`, and `install --strip-program`
- Catastrophic targets even inside the workspace: the workspace root itself, `~`, `/`, and `.git` paths
- The upstream Kimi dangerous list: `sudo rm -rf ...`, `shutdown`, `reboot`, `mkfs*`, `init 0/6`, `systemctl poweroff`, `dd of=/dev/sda`, ...

## What runs silently (examples)

`git status`, `ls -la`, `rg foo src/`, `npm test`, `cat /etc/hosts`, `cd /tmp && ls`, `rm -rf build/`, `echo x > out.txt`, `sed -i s/a/b/ src/file.ts`, `python script.py` / `bash scripts/build.sh` / `./scripts/check` (workspace scripts), explicitly listed development tools, and edits to lexical paths inside the workspace — no keystrokes.

External-directory permission and Bash-risk permission are intentionally independent. A dangerous command that also accesses an external directory may therefore show two dialogs: approval of directory access is not treated as approval of the command's separate Bash risk.

## Trust boundary and limitations

This plugin is a permission heuristic, not a sandbox or a proof of a process's eventual effects. It analyzes the submitted Bash command line; it does not inspect or sandbox the contents of scripts, binaries, package hooks, build tools, or other programs that the command starts.

Two deliberate exceptions remain. First, workspace scripts and executables such as `python script.py`, `bash scripts/build.sh`, and `./scripts/check` are trusted without inspecting their contents. Second, a finite allowlist of common development tools (`npm`, `pnpm`, `yarn`, `bun`, `make`, `cargo`, `go`, test/format/lint tools, and similar entries in the source policy) is trusted without inspecting project hooks or configuration. Such code can still write outside the workspace, delete files, access credentials, or use the network internally. These are explicit trust boundaries, not analyzer proofs; use OS/container sandboxing when the workspace is not trusted.

Workspace containment is currently lexical. A workspace path that traverses a symlink to an external target is still treated as inside the workspace. This is the other known containment limitation and is not resolved by the default-deny command policy.

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

The `permission` entries route every bash command and file edit through the approval flow — the plugin then auto-replies to positively trusted ones in milliseconds (same mechanism OpenCode's own auto mode uses), so unknown and risky cases remain at the dialog. `edit` routing is optional but recommended: without it, in-workspace edits follow your normal opencode rules. Project-level `plugin`/`permission` config merges with the global config.

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

## Behavior notes

- **`deny` rules always win.** Commands matched by a `deny` rule fail before the plugin is ever consulted.
- **`"always allow" bypasses the plugin** for the rest of the session. If you answer "always" on a dialog, that pattern is approved without analysis afterwards.
- **Unknown commands fail closed at every command gate.** A literal name is not enough: it must be present in the positive trust policy, and an executable containing a path must be a known system executable path or a workspace-local executable covered by the workspace-script trust boundary.
- **The legacy `upstream` option was removed.** It bypassed the workspace and positive-trust policies and therefore contradicted the default-deny invariant. Supplying the old option has no effect.
- **Workspace paths are lexical, not filesystem-canonical.** A literal path inside the workspace that traverses a symlink to an external target can escape the policy. Use a sandbox when this matters.
- **Reads, network access, and data exfiltration inside trusted scripts/tools are not sandboxed.** Unknown network tools and `git push` now ask, but an allowed workspace script or development tool can still perform those operations internally.
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
