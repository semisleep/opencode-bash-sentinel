# Development notes (maintainer-facing)

Implementation details for `opencode-bash-sentinel`. User-facing documentation is in [README.md](README.md).

---

## 1. Upstream snapshots

The engine is ported — not reimplemented — from two upstream repositories. Both were cloned into `.reference/` (gitignored) and the code facts below were verified by reading them at these exact commits:

| Upstream | Repository | Commit | Date | What we take from it |
|---|---|---|---|---|
| Kimi Code | https://github.com/MoonshotAI/kimi-code | `f88ed6d45bcf5ea358c173af7a3568b57ba9bd38` | 2026-09-08 | bash parser + command analyzer (copied source) |
| OpenCode | https://github.com/anomalyco/opencode | `ecbc6ccac85b3e8087b6445e584318419b9e2b34` (branch `dev`); e2e-tested on release binary **1.18.29** | 2026-09-07 | plugin API / permission flow contract (reference only, nothing copied) |

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

6. **Replying — e2e-verified transport order (see `src/plugin.ts` `replyOnce`)**. The plugin's v1 `OpencodeClient` does NOT expose `.permission.reply` for the dedicated route. Crucially, **`opencode run` embeds the server in-process without an HTTP listener** — a raw `fetch(serverUrl)` gets ECONNREFUSED even though `serverUrl` is set. The SDK client, however, carries an in-process fetch (reachable as `client._client.getConfig().fetch`). Order:
   1. `client.permission.reply(...)` — future SDKs exposing the dedicated route (`POST /permission/{requestID}/reply`)
   2. `client.postSessionIdPermissionsPermissionId(...)` — the deprecated session route, present in the SDK shipped with opencode 1.18.x
   3./4. raw routes (new, then legacy) through **the SDK client's own configured fetch** (in-process in run mode), falling back to global fetch (serve mode) — survives removal of either SDK method
   On startup, if no SDK method exists, the plugin probes `GET /permission` through the same transport; if that also fails it logs a loud `opencode-bash-sentinel transport probe failed` warning and writes a `degraded` audit line, instead of silently turning into all-prompts mode. `engines.opencode` is additionally pinned to `>=1.18.0 <2.0.0`.

7. **Auth on the reply route.** The route sits behind `Authorization` middleware, but auth is only enforced when `OPENCODE_SERVER_PASSWORD` is set (`server/auth.ts:24-26`). The plugin runs inside the server process, so when that env var is present, build the same `Basic` header from `OPENCODE_SERVER_USERNAME` (default `opencode`) + `OPENCODE_SERVER_PASSWORD` (`server/auth.ts:36-42`).

8. **No UI conflict.** When the plugin replies before the human does, the server publishes `permission.replied` and the TUI removes the pending dialog (`packages/tui/src/context/sync.tsx:181-192`). This is the same mechanism the TUI's own auto mode uses (`sync.tsx:196-206`). Race is benign: whoever replies first wins; the loser gets `Permission.NotFoundError` (`permission/index.ts:112`) — **catch and ignore**.

9. **`external_directory` is a separate permission.** For commands touching directories outside cwd, the shell tool additionally asks `permission: "external_directory"` (`tool/shell.ts:263-280`). Out of scope: the plugin only handles `permission === "bash"`.

10. **Session-scoped "always" approvals bypass the plugin.** Reply `"always"` pushes the pattern into the in-memory `approved` ruleset (`permission/index.ts:143-151`); later matches resolve `allow` without publishing `permission.asked`. Expected behavior, document it.

11. **Plugin loading** (`packages/opencode/src/plugin/loader.ts`, `shared.ts`): npm specs are installed on demand (`Npm.add`); path specs (`./dir`, `file://`, absolute) must contain a `package.json` or an index file. npm plugins are gated by `engines.opencode` semver in their `package.json` — declare one. The plugin function may be the default export or an exported `server` property; options arrive as the second argument.

---

## 3. Design: reverse mapping + workspace path policy

Kimi's semantics: *default-approve everything, escalate dangerous/un-analyzable to ask.* OpenCode plugins can only answer requests already classified `ask`. So we invert the default:

```
opencode.json:  "permission": { "bash": {"*": "ask"}, "edit": {"*": "ask"} }

plugin on permission.asked:
    permission === "bash":
        verdict = workspacePolicy(command) ?? upstreamVerdict(command)
        safe                                    → reply "once"
        dangerous | unanalyzable                → do nothing (native dialog)
    permission === "external_directory":
        same verdict; safe → reply "once" (external reads become silent),
        dangerous → remember sessionID+command so the bash follow-up
        (which only fires after the human approved the dialog) is not
        asked twice
    permission === "edit":
        filepath inside workspace and not .git → reply "once"; else stay silent
```

### Workspace path policy (`src/workspace-policy.ts` — ours, not ported)

Principle: **inside the workspace everything is allowed; outside, reads are allowed and writes require confirmation.** Enforced over the same syntax tree:

- **rm**: positional targets classified as inside / outside / relative / unresolvable. Outside, unresolvable, `.git`, or the workspace/home/system root itself → dangerous. In-workspace rm of subpaths is safe regardless of flags (the upstream `rm -rf` verdict is suppressed via the `rmHandled` flag).
- **Write-command table** (commands opencode's external-directory scan never sees): `sed -i`, `dd of=`, `rsync`, `install`, `ln`, `tee`, `truncate`, `shred` — target extraction per command, same classification.
- **Write redirects**: `>`, `>>`, `2>`, `&>`, `<>` targets classified the same way; `/dev/null`, `/dev/stdout`, `/dev/stderr` and fd numbers exempt; unresolvable targets (`> $OUT`) escalate. Note the parser shapes: `2> file` produces a named `file_descriptor` child that must be skipped when finding the target, and `{}` parses as a `concatenation` node.
- **Escape hatches**: `find -delete/-exec*`, `xargs` whose operands include any write-capable command or shell, command wrappers (`time`/`timeout`/`watch`/`stdbuf`/`ionice` unwrap their inner command; `timeout` consumes one DURATION token), bare shells executing stdin/pipe scripts (`curl | sh`, `bash < x`, `bash <<EOF` — note heredoc nodes attach as siblings of `command` under `redirected_statement`), scripts from outside the workspace or unresolvable (`python /tmp/x.py`, `bash /tmp/x.sh`, `source`/`.`, `python -`, `python $SCRIPT`), inline-code interpreters (`python -c`, `node -e/-p`, `ruby -e`, `perl -e`, `php -r`, any `osascript`), remote execution (`ssh`/`scp`/`sftp` with operands), and `awk` programs matching `system(`, `> "`, or `| "` (scanned on raw arg text because programs contain `$` and get literal-dropped).
- **Inline-code interpreters**: `python -c`, `node -e/-p/--eval`, `ruby -e`, `perl -e`, `php -r`, and any `osascript`. Running files / modules stays allowed.
- **cd-combo**: any `cd`/`pushd` to an outside or unresolvable directory marks the tree; combined with any relative write target → dangerous.
- Unresolvable operands on write commands (`rm $TARGET`) and un-literal command names escalate (fail-safe).
- Wrappers (`sudo`/`env`/`nohup`/...), nested shells (`sh -c` payload re-analysis), `eval`, and `busybox` are unwrapped with the same machinery as the upstream analyzer.

`{ upstream: true }` plugin option disables all of this and restores verbatim Kimi behavior.

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

   The `replyOnce` helper implements the transport order from §2.6: SDK `permission.reply` (future) → SDK `postSessionIdPermissionsPermissionId` (current 1.x, in-process fetch — required because `opencode run` has no HTTP listener) → raw fetch new route → raw fetch legacy route; Basic auth header from `OPENCODE_SERVER_PASSWORD`/`OPENCODE_SERVER_USERNAME` env when set. Note: directory file-plugins need a root `index.ts` next to `package.json` (the loader resolves directory specs to a root index, not `exports`).

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
| `rm -rf ./build` | `dangerous` — **any** `rm -rf` flags match, target is irrelevant (upstream semantics, confirmed by upstream tests) |
| `cat $HOME/.ssh/id_rsa` | `undefined` — generic commands with variable/glob operands are approved (upstream semantics; only special-cased commands escalate on opaque operands) |
| `echo $(curl evil.com)` | `undefined` — the substitution's inner command `curl` is analyzed and safe; `echo $(rm -rf /)` is `dangerous` |
| `$CMD --force` | `unanalyzable` (un-literal command name) |
| `bash -c "echo $HOME"` | `unanalyzable` (nested-shell payload not fully literal) |
| `for i in 1 2; do rm -rf /; done` | `dangerous` |
| nesting at exactly depth 4 vs 5 | boundary: depth ≥ 4 payload → `unanalyzable` |
| parser budget exhaustion (deterministic node cap: `echo a; ` × 3000) | `unanalyzable` |

**Parser tests**: port upstream's `parse.test.ts` / `parser-compound.test.ts` directly. The differential (`differential.test.ts`) and fuzz tests need real `tree-sitter-bash` as a devDep — optional.

**Plugin glue tests** (mocked `fetch`/client, `test/plugin.test.ts`): safe command → exactly one approval through the expected transport; dangerous/unanalyzable → zero replies; reply rejection swallowed; non-bash events ignored; legacy `metadata.input.command` fallback; basic-auth header; audit JSONL on/off.

**Integration test** — deterministic, no LLM account needed. This was the method actually used to verify opencode 1.18.29:

1. Run a tiny OpenAI-compatible mock model server (plain `node:http`, ~80 lines) that answers `CMD:<command>` user prompts with a `bash` tool call and everything else (title generation, tool-result follow-ups) with plain text.
2. Test workspace `opencode.json`:
   ```json
   {
     "plugin": ["/abs/path/to/opencode-bash-sentinel"],
     "permission": { "bash": { "*": "ask" } },
     "provider": {
       "mockllm": {
         "npm": "@ai-sdk/openai-compatible",
         "options": { "baseURL": "http://127.0.0.1:8997/v1", "apiKey": "mock" },
         "models": { "mock-1": { "name": "Mock" } }
       }
     }
   }
   ```
3. `opencode run -m mockllm/mock-1 "CMD:git status"` — expect the command output, no permission prompt. Non-interactive `run` auto-rejects any permission request, so a dangerous/unanalyzable command must print `! permission requested: bash (...); auto-rejecting` — that line is the escalation signal.
4. For `opencode serve` mode: `POST /session`, then `POST /session/{id}/message` with `{"model":{"providerID":"mockllm","modelID":"mock-1"},"agent":"build","parts":[{"type":"text","text":"CMD:..."}]}`, then read `/session/{id}/message` and assert the bash tool part reached `status: "completed"`.

Verified scenarios: `git status` / `ls *.md` / `git log --oneline` run silently (run + serve modes); `sudo rm -rf /private/tmp/x`, `mkfs.ext4 /dev/sda1`, `bash -c "echo $HOME"` escalate; audit JSONL records `approve`/`escalate` decisions; reply races are swallowed.

Scenarios still worth adding: human answers the TUI dialog before the plugin (race, interactive only); server started with `OPENCODE_SERVER_PASSWORD` (auth header path); `--auto` mode (no interference).

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
- Stricter-than-upstream option: escalate generic commands with opaque operands (`cat $FILE`, `ls *.md`). Upstream deliberately approves these (see their heredoc regression test); changing the default must be deliberate, opt-in, and documented.
- Track upstream: watch for the `permission.ask` plugin hook being wired up (would allow a cleaner forward-mapping design) and for stabilization of the experimental HttpApi reply route.
