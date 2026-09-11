# Project rules for agents

- NEVER commit, push, or create PRs automatically. Only run `git commit` / `git push` when the user explicitly asks for it in the current conversation. Preparing staged changes or showing a summary is fine; the commit itself always requires an explicit instruction.
- Before changing command analysis or permission policy, read `ARCHITECTURE.md`. Ordinary command support must fit its extension contract and must not change a core invariant, architecture decision, trust boundary, decision-unit/fact model, situation contract, or aggregation rule.
- If a requested command or bug fix cannot fit that extension contract, leave the form fail-closed and propose an architecture decision record. Do not implement the architectural change until the maintainer explicitly approves it.
- Profile-level changes (new or widened command profiles in `src/policy/profiles/`) must NOT touch `README.md`: the code is the authoritative catalogue by design, and the executable specification lives in `test/profiles/`. Update the profile's tests instead of its docs.
