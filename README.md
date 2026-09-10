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
3. A workspace script requires approval unless its entry file is committed, unchanged from `HEAD`, and has no visibly external or ambiguous path argument.

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

### Outside the workspace

A finite set of recognized read-only forms is allowed. Recognized writes and unsupported forms require approval.

```bash
cat /etc/hosts       # allow
ls -la /tmp          # allow
echo x > /tmp/out    # ask
```

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

The OpenCode `edit` permission uses a separate path rule: ordinary resolved workspace paths allow; `.git`, external, and unresolved paths ask. Editing a script is allowed, while later execution is evaluated by the script red line.

## OpenCode behavior

The `bash` and `external_directory` permissions are independent OpenCode gates, but Sentinel applies the same complete Bash policy to both. Sentinel replies `once` only for allowed requests; otherwise it leaves the native dialog unanswered so the user decides.

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

## Development and provenance

[ARCHITECTURE.md](ARCHITECTURE.md) is the stable policy constitution. [DEVELOPMENT.md](DEVELOPMENT.md) explains module ownership, extension rules, and verification. `CLAUDE.md` links to `AGENTS.md` so supported agents receive the same project instructions.

The Bash parser was adapted from Moonshot AI's open-source [Kimi Code](https://github.com/MoonshotAI/kimi-code) CLI at commit `f88ed6d45bcf5ea358c173af7a3568b57ba9bd38` under MIT. Sentinel's policy is independent of Kimi's former dangerous-command analyzer.

## License

MIT. Portions Copyright (c) 2026 Moonshot AI, Inc. See [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md).
