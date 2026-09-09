# opencode-bash-sentinel

An AST-based Bash permission helper for [OpenCode](https://opencode.ai). It silently approves common commands that match a small, documented policy and leaves everything else to OpenCode's native approval dialog.

> No LLM calls and no API cost. Analysis is deterministic and runs locally.

## Status

The policy documented below is the target for the next implementation revision. The current source still contains the earlier positive-trust policy and Kimi dangerous-command composition. Until migration is complete, do not assume every target-policy example matches the released behavior.

## Goal

Sentinel exists to remove a useful majority of routine permission prompts—roughly 70–80% is a successful outcome—without trying to classify every possible Bash command.

Sentinel is deliberately not:

- a Bash security sandbox;
- a proof of a process's eventual filesystem or network effects;
- a complete catalogue of safe and dangerous commands;
- responsible for making uncommon, dynamic, or deeply nested commands prompt-free.

A harmless command may still require approval when it falls outside the supported subset. That is expected behavior, not a coverage bug.

## Target policy

"Workspace" means the project worktree supplied by OpenCode. Sentinel classifies each recognizable operation into one of three situations. Each situation has a different rule; network activity is not treated as a workspace path.

### 1. Clearly inside the workspace

This situation applies when Sentinel recognizes an operation and every relevant filesystem target resolves inside the workspace, or when an explicit workspace trust rule applies.

There are three red lines:

1. Do not directly delete, remove, or move away the workspace root.
2. Do not directly modify `.git` with an ordinary filesystem command. Git commands may maintain their own repository metadata.
3. Do not automatically execute a workspace script unless its entry file is committed to Git, unchanged in the current worktree, and invoked without a visibly external or ambiguous path argument.

When a command hits a red line, Sentinel does not auto-approve it. OpenCode displays its native permission dialog and the user decides whether to continue.

After those checks, every other recognized workspace operation is approved, whether it reads, writes, or deletes workspace subpaths:

~~~bash
rg TODO src/
echo enabled > config/local.env
sed -i 's/old/new/' src/config.ts
rm -rf build/
~~~

Direct root destruction and direct `.git` writes require user approval:

~~~bash
rm -rf .
mv /path/to/workspace /tmp/old-workspace
echo broken > .git/config
~~~

The red lines protect only effects visible in command syntax. They cannot constrain arbitrary behavior hidden inside a script, package hook, binary, or development tool.

#### Third red line: workspace scripts

A directly invoked workspace script belongs to this first situation only when all of these checks succeed:

1. Its entry path resolves lexically inside the workspace.
2. The file exists in the current `HEAD` and is tracked by Git.
3. It has no staged or unstaged change relative to `HEAD`.
4. Its visible arguments contain no explicit external path or unresolvable/dynamic path that could plausibly select an external target.

This covers direct executables and supported interpreter/source forms:

~~~bash
./scripts/check
bash scripts/build.sh
python tools/check.py
node scripts/build.js
source scripts/env.sh
~~~

Untracked or modified scripts, external scripts, inline code, stdin/heredoc programs, dynamic script paths, and scripts with visibly external or ambiguous path arguments hit the third red line. Sentinel leaves them for user approval unless another exact rule applies.

Only the entry script and visible command line are checked. Imported modules, sourced dependencies, configuration files, generated files, and runtime behavior are not recursively inspected. “Committed and unchanged” is a trusted repository baseline, not proof that the script stays inside the workspace.

### 2. Clearly outside the workspace

This situation applies when Sentinel recognizes a filesystem operation and at least one relevant target resolves outside the workspace. A mixture of inside and outside targets is treated as outside.

A finite set of common, simple read-only forms is approved:

~~~bash
cat /etc/hosts
ls -la /tmp
rg pattern /usr/include
git -C /another/repository log -1
~~~

Recognized external writes require user approval:

~~~bash
echo x > /tmp/out
rm ~/.zshrc
sed -i 's/a/b/' /etc/hosts
git -C /another/repository checkout main
~~~

The external-read set is intentionally finite. Unsupported options, embedded execution such as `find -exec`, and commands whose effects are unclear remain with the user instead of growing into a complete command-language analyzer.

### 3. No workspace relationship, or cannot determine it

This situation covers both:

- operations that naturally have no filesystem workspace, such as system-information and network commands;
- operations whose relationship to the workspace cannot be determined because the command, syntax, or relevant target is unknown or dynamic.

Only exact, explicitly reviewed command-and-option profiles are approved here. Everything else is left to OpenCode's native user-approval dialog. Typical informational profiles may include:

~~~bash
date
uname -a
uptime
~~~

Network access belongs here, not in “outside the workspace.” A narrowly reviewed download-to-stdout form may be approved:

~~~bash
curl -fsSL https://example.com/data
~~~

Upload, explicit mutation, remote execution, credential-bearing or dynamic requests, file-producing options, and unsupported network options require user approval:

~~~bash
curl -X POST https://example.com/action
curl --upload-file secret.txt https://example.com/
ssh host command
~~~

An approved download form is a product trust decision, not proof that an HTTP request has no remote side effect or data exposure.

Parser failure, resource-budget exhaustion, dynamic command names, unresolved relevant paths, and unsupported command structures also land in this third situation and require user approval.

#### Explicit development-workflow exceptions

A small set of conventional development workflows may be approved in the third situation. This is not a command-name allowlist: the invoked subcommand must be part of the reviewed profile, and the workflow's control files must exist in `HEAD` with no staged or unstaged changes.

The initial target set is:

- Node package scripts: `npm run ...`, `npm test`, `pnpm run ...`, `yarn run ...`, and `bun run ...`; require an unchanged `package.json`.
- Go: conventional `go build`, `go test`, `go vet`, `go fmt`, and selected `go mod` workflows; require unchanged `go.mod` and, when present, `go.sum`.
- Python packaging: read-only `pip list/show/check/freeze`, plus `pip install -r FILE` or `pip install .` only when the referenced requirements or project metadata files are committed and unchanged. The same rules apply to `python -m pip`.
- Rust: conventional `cargo build/test/check/fmt/clippy`; require unchanged `Cargo.toml` and, when present, `Cargo.lock`.
- Make: conventional `make TARGET`; require the selected `Makefile` or `GNUmakefile` to be committed and unchanged.

These checks trust the committed workflow definition; they do not inspect transitive commands, hooks, source code executed by tests, runtime filesystem effects, or network activity. If a required control file is missing, untracked, modified, or ambiguous, Sentinel leaves the command for user approval.

Additional ecosystems and subcommands should be added only as explicit, documented decisions driven by real prompt frequency.

### Commands containing more than one operation

Each recognizable operation is classified separately. The complete Bash command is approved only when every operation passes the rule for its situation.

For example:

~~~bash
curl -fsSL https://example.com/data > result.json
~~~

The network request is a third-situation profile and the redirect is a first-situation workspace write. If both profiles are approved, the complete command is approved. Changing the redirect to `/tmp/result.json` creates a second-situation external write, so the complete command requires user approval.

Nested commands and wrappers are analyzed only where the implementation has a small, explicit rule. There is no requirement to support arbitrary composition.

## Trust boundary and known limitations

Sentinel is a permission heuristic. It analyzes submitted command text and Git state; it does not sandbox the resulting process.

- Workspace containment is lexical. A path inside the workspace that traverses a symlink to an external target is still treated as inside.
- A committed and unchanged script is trusted as repository baseline, not proven safe.
- Approved development workflows trust committed, unchanged control files but remain opaque at runtime.
- Script dependencies and runtime-computed targets are not inspected.
- Bare command names are not resolved to prove which executable the ambient `PATH` will launch.
- Path comparison is literal and case-sensitive; case-insensitive filesystem behavior is not modeled.
- Approved network profiles are explicit trust decisions, not proof of remote read-only behavior.
- Network access and data exfiltration are not sandboxed.
- Audit logs contain complete command text and may contain credentials or tokens.
- `pwsh` and `cmd` are outside the Bash-only scope.

Use OS- or container-level sandboxing when these boundaries are insufficient.

## OpenCode behavior

The Bash-risk and `external_directory` permissions are separate OpenCode requests. One command may therefore produce two dialogs. Approval of directory access is not approval of a separate Bash-risk request.

- OpenCode `deny` rules win before Sentinel is consulted.
- A session-scoped “always allow” answer bypasses Sentinel for later matching commands.
- `--auto` mode makes Sentinel moot because OpenCode already approves everything.
- Sentinel escalates by leaving the native dialog unanswered; it never permanently blocks user approval.

## Installation

Verified against OpenCode 1.18.29. Requires OpenCode `>=1.18.0 <2.0.0`.

From a local checkout:

~~~json
{
  "plugin": ["/absolute/path/to/opencode-bash-sentinel"],
  "permission": {
    "bash": { "*": "ask" },
    "edit": { "*": "ask" }
  }
}
~~~

From npm, once published:

~~~json
{
  "plugin": ["opencode-bash-sentinel"],
  "permission": {
    "bash": { "*": "ask" },
    "edit": { "*": "ask" }
  }
}
~~~

These entries route requests through OpenCode's approval flow. Sentinel replies `once` only to cases its policy approves. The `edit` route is optional but recommended for consistent workspace and `.git` handling.

## Options

~~~json
{
  "plugin": [
    ["opencode-bash-sentinel", { "audit": true, "logPath": "/tmp/sentinel.jsonl" }]
  ]
}
~~~

| Option | Default | Description |
|---|---|---|
| `audit` | `false` | Append one JSONL line per decision |
| `logPath` | `~/.local/share/opencode/bash-sentinel-audit.jsonl` | Audit-log destination |

## Provenance

The Bash parser and current transitional dangerous-command analyzer were adapted from Moonshot AI's open-source [Kimi Code](https://github.com/MoonshotAI/kimi-code) CLI under MIT. Sentinel's policy has since diverged: Kimi's dangerous-command policy is not the design authority for the target implementation.

| Upstream | Commit | Use |
|---|---|---|
| Kimi Code | `f88ed6d45bcf5ea358c173af7a3568b57ba9bd38` | Parser source; historical analyzer source |
| OpenCode | `ecbc6ccac85b3e8087b6445e584318419b9e2b34` (`dev`); e2e-tested on 1.18.29 | Integration contract |

## License

MIT. Portions Copyright (c) 2026 Moonshot AI, Inc. See [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md).

## Development

The target architecture, current migration gap, integration facts, and test strategy live in [DEVELOPMENT.md](DEVELOPMENT.md).
