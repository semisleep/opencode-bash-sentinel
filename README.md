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

"Workspace" means the project worktree supplied by OpenCode. Sentinel parses Bash, verifies that every execution- or I/O-relevant syntax node is accounted for, and extracts command and redirect decision units. A finite recognizer either accepts a unit's complete shape and produces classification facts or marks it unsupported. Accepted facts place the unit into one of three situations. Each situation has a different rule; network activity is not treated as a workspace path.

Classification is intentionally finite. Only commands with a supported path recognizer can enter the first two situations. An unknown command does not become a workspace command merely because one argument looks like `./file`; unsupported command shapes go directly to the third situation.

### 1. Clearly inside the workspace

This situation applies when a supported path recognizer understands the complete command shape and every relevant filesystem target resolves inside the workspace. Relative paths are resolved from the OpenCode-provided cwd, but cwd alone never makes a path-free command a workspace command.

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
rmdir /path/to/workspace
echo broken > .git/config
~~~

The red lines protect only effects visible in command syntax. They cannot constrain arbitrary behavior hidden inside a script, package hook, binary, or development tool.

#### Third red line: workspace scripts

A supported direct script invocation is classified from its entry-script path. When that entry path resolves inside the workspace, the invocation is in this first situation and is automatically approved only when all of these red-line checks succeed:

1. Its entry path resolves lexically inside the workspace.
2. The file exists in the current `HEAD` and is tracked by Git.
3. It has no staged or unstaged change relative to `HEAD`.
4. Its visible arguments contain no explicit external path or unresolvable/dynamic path that could plausibly select an external target.

Only the entry-script path chooses the situation. Visible arguments are a script-specific red-line check, not inputs to a generic path classifier.

This covers direct executables and supported interpreter/source forms:

~~~bash
./scripts/check
bash scripts/build.sh
python tools/check.py
node scripts/build.js
source scripts/env.sh
~~~

An untracked or modified workspace script, ambiguous Git state, or a visibly external or ambiguous argument therefore requires user approval under this red line. No situation-3 profile overrides it. An external entry script is instead situation 2; inline code, stdin/heredoc programs, and dynamic entry paths are situation 3. Those forms also require user approval under the initial profiles, but they do not become workspace-script red-line cases.

Only the entry script and visible command line are checked. Imported modules, sourced dependencies, configuration files, generated files, and runtime behavior are not recursively inspected. “Committed and unchanged” is a trusted repository baseline, not proof that the script stays inside the workspace.

For `source FILE` and `. FILE`, the same entry-file checks apply. Once such a file is trusted, Sentinel does not model how it changes cwd, variables, functions, aliases, shell options, or the meaning of later commands in the same Bash source. This is part of the accepted committed-script trust boundary; it does not introduce recursive shell-state analysis.

### 2. Clearly outside the workspace

This situation applies when a supported path recognizer understands the complete command shape and at least one relevant target resolves outside the workspace. A mixture of inside and outside targets is treated as outside; Sentinel does not need to split sources and destinations to find additional safe cases.

A finite set of common, simple read-only forms is approved:

~~~bash
cat /etc/hosts
ls -la /tmp
rg pattern /usr/include
~~~

Recognized external writes require user approval:

~~~bash
echo x > /tmp/out
rm ~/.zshrc
sed -i 's/a/b/' /etc/hosts
~~~

The external-read set is intentionally finite. Unsupported options, embedded execution such as `find -exec`, and commands whose effects are unclear remain with the user instead of growing into a complete command-language analyzer.

### 3. No workspace relationship, or cannot determine it

This situation covers both:

- operations that naturally have no filesystem workspace, such as system-information and network commands;
- operations whose relationship to the workspace cannot be determined because the command, syntax, or relevant target is unknown or dynamic.

Only exact, explicitly reviewed command-and-option profiles are approved here. Everything else is left to OpenCode's native user-approval dialog. The initial informational set covers ordinary forms of the following commands, plus plain stdout-only `echo` and `printf` forms:

~~~bash
date
uname -a
uptime
whoami
id
free -h
vm_stat
nproc
lscpu
ps aux
~~~

Network access belongs here, not in “outside the workspace.” The initial network profile is a literal HTTP(S) `curl` GET or HEAD request whose response goes to stdout. It accepts only `-f/--fail`, `-s/--silent`, `-S/--show-error`, `-L/--location`, `-I/--head`, `--compressed`, and numeric connect-timeout, maximum-time, retry, and retry-delay options:

~~~bash
curl -fsSL https://example.com/data
~~~

Upload, explicit mutation, remote execution, credential-bearing or dynamic requests, file-producing options, and unsupported network options require user approval:

~~~bash
curl -X POST https://example.com/action
curl --upload-file secret.txt https://example.com/
ssh host command
~~~

An approved download form is a product trust decision, not proof that an HTTP request has no remote side effect or data exposure. Curl's ambient configuration and proxy environment are not inspected.

Dynamic command names and unresolved relevant paths use this third situation and require user approval. Parser failure, resource-budget exhaustion, and unsupported source structure fail earlier in the pipeline and also require user approval; they are not classified as decision units.

#### Explicit development-workflow exceptions

A small set of conventional development workflows is approved in the third situation only when the rules below match. This is not a command-name allowlist: the invoked subcommand must be part of the reviewed profile, and the workflow's control files must exist in `HEAD` with no staged or unstaged changes.

The initial target set is:

- Node package scripts: `npm run ...`, `npm test`, `pnpm run ...`, `yarn run ...`, and `bun run ...`; require an unchanged `package.json`.
- Go: `go build`, `go test`, `go vet`, `go fmt`, `go mod download`, and `go mod tidy`; require unchanged `go.mod` and, when present, `go.sum`.
- Python packaging: read-only `pip list/show/check/freeze`, plus `pip install -r FILE` or `pip install .` only when the referenced requirements or project metadata files are committed and unchanged. The same rules apply to `python -m pip`.
- Rust: conventional `cargo build/test/check/fmt/clippy`; require unchanged `Cargo.toml` and, when present, `Cargo.lock`.
- Make: conventional `make TARGET`; require the selected `Makefile` or `GNUmakefile` to be committed and unchanged.

These checks trust only the direct entry control file selected by the command. They do not recursively inspect workspace configuration, included Makefiles or requirements, build scripts, transitive commands, hooks, source code executed by tests, runtime filesystem effects, or network activity. If a required control file is missing, untracked, modified, or ambiguous, Sentinel leaves the command for user approval.

Additional ecosystems and subcommands should be added only as explicit, documented decisions driven by real prompt frequency.

#### Git profiles

All Git invocations belong to the third situation, including path-free commands executed from the OpenCode cwd. The initial profile approves `status`, `diff`, `log`, `show`, `blame`, `rev-parse`, `ls-files`, `grep`, `add`, `commit`, and `fetch` in their supported ordinary forms.

`git -C DIR` remains in the third situation, but `DIR` is a profile constraint: an external directory permits only the read-only subset, while a dynamic or unresolved directory requires user approval. `--git-dir`, `--work-tree`, unknown global options, `push`, `pull`, `reset`, `clean`, `checkout`, `switch`, `restore`, credential/configuration mutation, and other unlisted subcommands require user approval.

Git hooks, configuration, aliases, filters, and the actual repository selected by ambient process state are not recursively inspected.

#### Environment assignments

Leading Bash assignments are allowed as ordinary syntax and do not become wrappers; Sentinel ignores them while continuing to classify the associated command. Standalone assignment and recognized assignment forms of `export`, `declare`, `typeset`, and `readonly` are also allowed. Both rules have one exception: assignments to this short high-risk name set require user approval:

`PATH`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, `DYLD_*`, `BASH_ENV`, `ENV`, `ZDOTDIR`, `GIT_DIR`, `GIT_WORK_TREE`, `HOME`, `CDPATH`, `NODE_OPTIONS`, `PYTHONPATH`, `PYTHONSTARTUP`, `RUBYOPT`, `RUBYLIB`, and `PERL5OPT`.

Assigning one of these names requires user approval because it can change executable identity, load code, or redirect path resolution. Tool-specific variables outside this short list are not modeled. The `env ... COMMAND` executable is a wrapper, not Bash assignment syntax, and is unsupported initially.

### Commands containing more than one decision unit

Commands, redirects, and nested executable nodes such as command substitutions become separate decision units when they are represented by the Bash AST. Before any approval, every execution- or I/O-relevant AST node must either be consumed by a supported rule or cause the complete Bash source to require user approval. Unsupported nodes are never silently ignored.

The initial supported composition subset includes simple commands and redirects, ordinary pipelines, flat lists joined by newline, `;`, `&&`, or `||`, leading Bash assignments, one literal `cd DIR` transition followed by a supported command, and fully extracted command substitutions whose containing invocation remains recognized. For lists and pipelines, every syntactically present unit must allow; Sentinel does not predict which branch or process will run.

`if`, loops, `case`, functions, background jobs, subshells, brace groups, process substitutions, dynamic cwd changes, and other structures requiring control-flow or shell-state analysis require user approval in the initial policy.

For example:

~~~bash
curl -fsSL https://example.com/data > result.json
~~~

The curl invocation is a third-situation profile and the redirect is a first-situation workspace write. If both units are approved, the complete command may be approved. Changing the redirect to `/tmp/result.json` creates a second-situation external write, so the complete command requires user approval.

Every recognized direct mutation contributes a `mutationScope`: a path or directory range whose contents, existence, or location may change. A script or development-workflow profile that relies on an analysis-time file state contributes that path as a `stabilityDependency`. If any mutation scope overlaps any stability dependency in the same Bash source, the complete source requires user approval. The comparison is deliberately order-independent and does not attempt control-flow analysis:

~~~bash
sed -i 's/safe/dangerous/' scripts/check.sh && ./scripts/check.sh
printf '%s' '{}' > package.json && npm run build
~~~

Both examples require approval even if all individual units would otherwise be allowed. Git may establish that a dependency is initially committed and unchanged, but the cross-unit conflict rule is generic and is not a Git-specific part of the aggregator. Hidden mutations inside an approved script or development tool are not modeled.

Wrapper arguments and embedded command strings are not reinterpreted as commands. `sudo`, `env ... COMMAND`, `timeout`, `watch`, `nohup`, `nice`, `stdbuf`, `xargs`, `sh -c`, `bash -c`, and `eval` therefore enter the third situation and require user approval in the initial policy. This avoids recursive wrapper grammars and arbitrary nested analysis.

Every redirection form must also be explicitly understood. Read-write redirects such as `<>` are writes. Bash network paths such as `/dev/tcp/...` and `/dev/udp/...`, dynamic file-descriptor paths, heredocs, here-strings, process substitutions, and expansions whose executable contents are not completely accounted for require user approval in the initial policy. Ordinary exact exceptions such as `/dev/null` may have their own finite rule.

The complete Bash source is automatically approved only when parsing succeeds, all relevant AST nodes are accounted for, every decision unit is allowed by its situation, and no mutation scope overlaps a stability dependency.

## Trust boundary and known limitations

Sentinel is a permission heuristic. It analyzes submitted command text and Git state; it does not sandbox the resulting process.

- Workspace containment is lexical. A path inside the workspace that traverses a symlink to an external target is still treated as inside.
- A committed and unchanged script is trusted as repository baseline, not proven safe.
- Approved development workflows trust committed, unchanged control files but remain opaque at runtime.
- Script dependencies and runtime-computed targets are not inspected.
- A trusted `source`/`.` file may change the Shell state and therefore the meaning of later commands in the same Bash source; those changes are not modeled.
- Another process may change filesystem or Git state after analysis and before the approved command executes; Sentinel does not provide an atomic snapshot.
- Bare command names are not resolved to prove which executable the ambient `PATH` will launch.
- Path comparison is literal and case-sensitive; case-insensitive filesystem behavior is not modeled.
- Approved network profiles are explicit trust decisions, not proof of remote read-only behavior.
- Curl configuration, proxies, and other ambient network settings are not inspected.
- Environment variables outside the short high-risk name set may still alter tool-specific behavior.
- Network access and data exfiltration are not sandboxed.
- Audit logs contain complete command text and may contain credentials or tokens.
- `pwsh` and `cmd` are outside the Bash-only scope.

Use OS- or container-level sandboxing when these boundaries are insufficient.

## File-edit permission

The OpenCode `edit` permission is separate from the Bash command architecture and will be reviewed independently. Its current implementation uses this simple path rule:

- an edit to an ordinary path inside the workspace is automatically approved;
- an edit to `.git`, outside the workspace, or to an unresolved path requires user approval.

Editing a workspace script is allowed. The third red line applies when that now-modified script is later executed, not when it is edited.

## OpenCode behavior

The `bash` and `external_directory` permissions are separate OpenCode requests. One command may therefore produce two dialogs, and approval at either gate does not approve the other. Sentinel nevertheless applies the same complete Bash analysis, three situations, red lines, and aggregation requirements at both gates; `external_directory` is not a relaxed policy path.

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

The stable product model, trust assumptions, decision pipeline, extension boundaries, and architecture-change process live in [ARCHITECTURE.md](ARCHITECTURE.md). Current profile details, the implementation gap, integration facts, migration plan, and test strategy live in [DEVELOPMENT.md](DEVELOPMENT.md).

Adding a recognized command or option is an expected extension when it fits the existing fact and situation model. Changing decision-unit boundaries, the three situations, fail-closed behavior, red lines, aggregation, or a documented trust boundary requires an explicit architecture decision and synchronized documentation and tests; it must not be smuggled into a command-specific fix.
