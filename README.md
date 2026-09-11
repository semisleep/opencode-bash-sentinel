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

The OpenCode `edit` permission follows the same path rules as the Bash gate's write side: ordinary resolved workspace paths allow; in-workspace `.git` paths, sensitive roots, and unresolved paths ask; external edits allow only as strict descendants of a designated scratch root (including their `.git` paths), while scratch roots themselves and every other external path ask. Editing a script is allowed, while later execution is evaluated by the script red line. `scratchPaths: false` disables the scratch allowance for both the Bash and edit gates.

## OpenCode behavior

The `bash` and `external_directory` permissions are independent OpenCode gates, but Sentinel applies the same complete Bash policy to both, and every gate consults the same path rules: one rule table for external reads and external mutations, consumed by the Bash situation classifier, the edit gate, and the external read path alike. Sentinel replies `once` only for allowed requests; otherwise it leaves the native dialog unanswered so the user decides.

Path-tool `external_directory` asks (for example from the `read` or `glob` tools) follow the same outside-workspace read rule when their payload positively identifies a read-only origin: non-sensitive external paths allow, sensitive roots ask, and write-origin or unrecognized shapes stay with the native dialog.

This origin identification is payload-based rather than an upstream contract — it was derived from the OpenCode 1.18.29 implementation and must be re-verified when the supported engine range changes. If a future engine changes these ask shapes, external read approvals revert to prompts (fail-closed). With `audit` enabled, every unanswered `external_directory` ask — including the edit family — is logged with its metadata shape, so such drift is visible in the audit log instead of silent.

- OpenCode `deny` rules take precedence.
- Session-scoped “always allow” answers bypass later Sentinel analysis.
- `--auto` mode already approves everything and makes Sentinel unnecessary.

## Installation

Verified against OpenCode 1.18.29. Requires OpenCode `>=1.18.0 <2.0.0`.

From a local checkout:

```json
{
  "plugin": ["/absolute/path/to/opencode-bash-sentinel"],
  "permission": {
    "bash": { "*": "ask" },
    "edit": { "*": "ask" }
  }
}
```

From npm, once published:

```json
{
  "plugin": ["opencode-bash-sentinel"],
  "permission": {
    "bash": { "*": "ask" },
    "edit": { "*": "ask" }
  }
}
```

The `edit` route is optional but recommended for consistent workspace and `.git` handling.

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
| `audit` | `false` | Append one JSONL line per decision |
| `logPath` | `~/.local/share/opencode/bash-sentinel-audit.jsonl` | Audit-log destination |
| `sensitivePaths` | `[]` | Extra sensitive-read roots, unioned with the built-in defaults (additive only) |
| `alert` | `false` | `true`, or `{ "sound": true, "mark": true }` per channel. `sound` also accepts a sound-file path. `mark` colors the iTerm2 tab chrome, shows a blinking red tab dot, and bounces the dock icon once; it clears when the permission is replied. Other terminals ignore the mark sequences |

## Development and provenance

[ARCHITECTURE.md](ARCHITECTURE.md) is the stable policy constitution. [DEVELOPMENT.md](DEVELOPMENT.md) explains module ownership, extension rules, and verification. `CLAUDE.md` links to `AGENTS.md` so supported agents receive the same project instructions.

The Bash parser was adapted from Moonshot AI's open-source [Kimi Code](https://github.com/MoonshotAI/kimi-code) CLI at commit `f88ed6d45bcf5ea358c173af7a3568b57ba9bd38` under MIT. Sentinel's policy is independent of Kimi's former dangerous-command analyzer.

## License

MIT. Portions Copyright (c) 2026 Moonshot AI, Inc. See [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md).
