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

Then diff the relevant paths (below), reapply the documented local hardening in `src/analyzer.ts`, re-verify the integration facts in §2 (they have moved before), update the commit table here and in README.md, and re-run the test suite.

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

## 3. Design: positive trust + workspace path policy

Kimi's analyzer remains a source of known-danger signals, but its native semantics are default-approve. The final policy engine must not inherit that default. OpenCode plugins can only answer requests already classified `ask`, so the plugin replies only after a separate positive-trust pass succeeds:

```
opencode.json:  "permission": { "bash": {"*": "ask"}, "edit": {"*": "ask"} }

plugin on permission.asked:
    permission === "bash":
        parse command once
        decision = compose(workspacePolicy(ast), positiveTrust(ast), upstreamVerdict(ast))
        explicitly trusted and path-safe        → reply "once"
        unknown | dangerous | unanalyzable      → do nothing (native dialog)
    permission === "external_directory":
        same verdict; safe → reply "once" (external reads become silent),
        dangerous → do nothing (native dialog); any later bash ask is
        evaluated independently because directory consent is not bash consent
    permission === "edit":
        filepath inside workspace and not .git → reply "once"; else stay silent
```

### Workspace path policy (`src/workspace-policy.ts` — ours, not ported)

Principle: **only explicitly recognized commands are candidates for approval; recognized writes are allowed inside the workspace, while outside writes require confirmation.** Enforced over the same syntax tree:

- **rm**: positional targets are resolved against the current abstract cwd. Outside, unresolvable, `.git`, or the workspace/home/system root itself (including `.` at workspace root) → dangerous. In-workspace rm of subpaths is safe regardless of flags (the workspace result explicitly sets `suppressUpstreamRmRf` to override upstream's path-blind rule).
- **Write-command table** (commands opencode's external-directory scan never sees): `sed -i`, `dd of=`, `rsync`, `install`, `ln`, `tee`, `truncate`, `shred` — target extraction per command, same classification. `install -d` checks every positional target, rather than applying copy-style “last operand is destination” semantics.
- **Write redirects**: `>`, `>>`, `2>`, `&>`, `<>` targets classified the same way; `/dev/null`, `/dev/stdout`, `/dev/stderr` and fd numbers exempt; unresolvable targets (`> $OUT`) escalate. Note the parser shapes: `2> file` produces a named `file_descriptor` child that must be skipped when finding the target, and `{}` parses as a `concatenation` node.
- **Escape hatches**: `find -delete/-exec*` and file-output actions, `xargs` whose operands include any write-capable command or shell (plus commands such as `file` whose meaning can be changed by appended operands), `rsync` output/temporary paths and remote destinations, command wrappers (`time`/`timeout`/`watch`/`stdbuf`/`ionice` unwrap their inner command; `timeout` consumes one DURATION token), bare shells executing stdin/pipe scripts (`curl | sh`, `bash < x`, `bash <<EOF` — note heredoc nodes attach as siblings of `command` under `redirected_statement`), scripts from outside the workspace or unresolvable (`python /tmp/x.py`, `bash /tmp/x.sh`, `source`/`.`, `python -`, `python $SCRIPT`), inline-code interpreters (`python -c`, `node -e/-p`, `ruby -e`, `perl -e`, `php -r`, any `osascript`), remote execution (`ssh`/`scp`/`sftp` with operands), and `awk` programs containing `system(`, output redirection, or command pipes.
- **Interpreter options**: leading options are parsed with per-interpreter rules so consumed values cannot hide a later script path (`python -W ignore /tmp/x.py`, `bash -O extglob /tmp/x.sh`). Config paths such as shell `--rcfile`, and Ruby/Perl `-I` search directories, are checked separately. Node/Ruby preload options require an explicit workspace path; opaque module names and URL-like specifiers clear positive trust. Unknown or deliberately unmodeled options do the same. Inline code (`python -c`, `node -e/-p/--eval`, `ruby -e`, `perl -e`, `php -r`, any `osascript`) and interpreters that still have no script after option parsing (`python`, `bash -O extglob`) escalate. Recognized workspace files and Python `-m` modules stay allowed.
- **Shell state mutation**: sensitive assignments are checked both as syntax nodes/wrapper arguments and for builtin mutation forms; currently `printf -v` escalates because it can replace `PATH` and affect later commands.
- **cwd tracking**: `cd`/`pushd` update a conservative set of possible cwd values. Conditional lists, branches, loops, command substitutions, functions, and subshells retain alternate cwd states; a relative path must be safe from every possible cwd. Unresolvable cwd changes combined with a relative write escalate. External or unresolvable `env -C`/`--chdir` and `sudo -D`/`--chdir` fail closed.
- **External-directory confidence**: the workspace pass also reports whether every command's external-path behavior has an explicit model. The external gate auto-approves only when the normal verdict is safe and this confidence bit is true; unknown tools and unmodeled script execution stay with the human.
- **Positive Bash confidence**: the workspace pass independently reports whether every executable has a positive trust rule. Literal-but-unknown commands, untrusted executable paths such as `/tmp/ls`, unrecognized `git` subcommands, and arbitrary environment assignments clear this bit. The Bash gate never approves when it is false.
- **Executable identity**: bare allowlisted command names and executable paths in `/bin`, `/sbin`, `/usr/bin`, or `/usr/sbin` may use the named rule. Bare names are not resolved against the ambient `PATH`; this provenance limitation is documented in README. Other path-qualified executables ask unless they resolve lexically inside the workspace, which is the documented workspace-script trust boundary.
- **Workspace root**: `rm` and destructive/metadata-oriented writers (`chmod`, `chown`, `touch`, `rmdir`, `truncate`, `shred`, and `install -d`) cannot target the workspace root. Copy/content-producing commands may target `.` because they create entries beneath the root.
- **Explicit exceptions**: workspace scripts/executables and the finite `TRUSTED_DEVELOPMENT_COMMANDS` list are trusted without inspecting their contents, hooks, or project configuration. Symlink targets are also not canonicalized. These limitations must remain visible in README.
- Unresolvable operands on write commands (`rm $TARGET`) and un-literal command names escalate (fail-safe).
- Wrappers (`sudo`/`env`/`nohup`/...), nested shells (`sh -c` payload re-analysis), `eval`, and `busybox` are unwrapped with the same machinery as the upstream analyzer.

The former `{ upstream: true }` escape hatch was removed because it disabled these invariants. Passing that legacy option is ignored.

### Failure modes

- Analyzer throws / parser times out → treated as `unanalyzable` → left to the human (fail-safe). The upstream parser already converts budget exhaustion to `{ ok: false, reason: 'aborted' }` and internal bugs to a degraded `hasError` tree (`parse.ts`).
- Reply race (human answered first) → `NotFoundError` → catch, ignore.
- Handle `bash`, `external_directory`, and `edit`; ignore unrelated permission and event types.

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
│   ├── policy-engine.ts   # parse-once orchestration and policy composition
│   ├── workspace-policy.ts # path/effect rules and possible-cwd analysis
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

2. **Refresh the analyzer** from `packages/agent-core-v2/src/agent/permissionPolicy/policies/dangerous-command-ask.ts`. Remove DI decorators and `IBashParserService`/config imports, then retain the local nested-shell and `sudo --chdir` hardening called out in the source header. Provide the parse function as `(source: string) => BashParseResult`, adapting `rootNode` → `root`.

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

**Upstream-analyzer unit tests** (table-driven, `vitest`) — `undefined` means only “the upstream dangerous list did not match”; it is not a final auto-approval decision. Final decisions are tested through the policy engine/plugin:

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

**Plugin glue tests** (mocked `fetch`/client, `test/plugin.test.ts`): positively trusted command → exactly one approval through the expected transport; unknown/dangerous/unanalyzable → zero replies; unknown literal commands, untrusted executable paths, remote git, environment assignments, `find`/`rsync` output channels; documented workspace-script/development-tool exceptions; reply rejection swallowed; unrelated events ignored; legacy `metadata.input.command` fallback; basic-auth header; audit JSONL on/off.

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

- Other permissions beyond `bash`, `edit`, and `external_directory` remain under opencode rules.
- Kimi's other policies (git-cwd-write-approve, sensitive-file-access-ask) could be ported later the same way.
- An optional "observe mode" (log what would be approved, approve nothing) for a burn-in period.
- Expand positive command coverage conservatively. Each addition needs tests for command-specific write/exec options; an unknown command or uncertain effect must continue to ask.
- Track upstream: watch for the `permission.ask` plugin hook being wired up (would allow a cleaner forward-mapping design) and for stabilization of the experimental HttpApi reply route.
