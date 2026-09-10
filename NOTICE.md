# NOTICE

This product includes source code adapted from
[MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code) (MIT License,
Copyright (c) 2026 Moonshot AI), pinned at commit
`f88ed6d45bcf5ea358c173af7a3568b57ba9bd38` (2026-09-08).

Ported files and their upstream paths:

| File in this repo | Upstream path |
|---|---|
| `src/parser/lexer.ts` | `packages/tree-sitter-bash/src/lexer.ts` |
| `src/parser/parser.ts` | `packages/tree-sitter-bash/src/parser.ts` |
| `src/parser/grammar.ts` | `packages/tree-sitter-bash/src/grammar.ts` |
| `src/parser/node.ts` | `packages/tree-sitter-bash/src/node.ts` |
| `src/parser/parse.ts` | `packages/tree-sitter-bash/src/parse.ts` |
| `src/parser/budget.ts` | `packages/tree-sitter-bash/src/budget.ts` |
| `src/parser/index.ts` | `packages/tree-sitter-bash/src/index.ts` |

`src/workspace-policy.ts`, `src/plugin.ts`, and `index.ts` are original to this
project (the workspace read/write path policy, the permission-reply glue, and
the edit/external gates); they contain no upstream code.

Adaptations: the `#/*` import alias was rewritten to relative imports. The
project's policy engine is original code and does not compose the former Kimi
dangerous-command analyzer; only the attributed Bash parser remains.

The OpenCode plugin integration (`src/plugin.ts`) was written for this project
and verified against opencode commit `ecbc6ccac85b3e8087b6445e584318419b9e2b34`
(branch `dev`, 2026-09-07); no opencode source is included.
