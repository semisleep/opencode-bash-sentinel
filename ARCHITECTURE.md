# Architecture constitution

This document defines the stable decision model for `opencode-bash-sentinel`. It is intentionally independent of the current command catalogue. [README.md](README.md) explains the product; [DEVELOPMENT.md](DEVELOPMENT.md) explains how to extend the implementation.

A local feature or bug fix must conform to this constitution. Changing it requires the architecture-change process below.

## 1. Product invariants

1. Sentinel is a prompt-reduction tool, not a Bash sandbox or complete safety classifier.
2. Roughly 70–80% prompt reduction is sufficient; complete coverage is not a goal.
3. Automatic approval requires positive recognition of a finite, complete form.
4. Unknown, unsupported, ambiguous, partially recognized, or resource-exhausted input asks.
5. Decisions are deterministic and local and do not use an LLM.

The governing direction is:

```text
recognized complete form -> evaluate its policy
anything else            -> ask
```

It must never become “no known danger found, therefore allow.”

## 2. Trust model

Sentinel reasons about submitted syntax and a small set of static facts. It does not prove eventual runtime behavior.

The following are accepted trust boundaries:

- workspace containment is lexical; symlink-canonical containment is not modeled;
- ambient `PATH` is not resolved to establish executable identity;
- a committed and unchanged workspace entry script is trusted without recursively inspecting its imports, configuration, generated inputs, or effects;
- a recognized development workflow trusts only its direct declared control files, not hooks, transitive commands, build graphs, or runtime effects;
- an approved `source` file may alter later shell interpretation; shell state is not simulated;
- arbitrary environment semantics, network side effects, tool configuration, and concurrent changes between analysis and execution are not modeled.

These boundaries may be changed only as architecture decisions, not by quietly widening a command profile.

## 3. Decision pipeline

The pipeline is a core invariant:

```text
bounded Bash parse
      -> normalize supported syntax and require full relevant-node coverage
      -> extract independent decision units
      -> recognize each complete unit and emit typed facts
      -> classify each unit into exactly one situation
      -> apply that situation's rule
      -> require all units to allow and no stability conflict
```

An allow result replies `once` to OpenCode. An ask result leaves the native dialog to the user.

### Structural completeness

Every execution- or I/O-relevant AST node must be consumed or explicitly rejected. New parser node types fail closed until normalization handles them.

The supported composition model is deliberately bounded: simple commands, explicit redirects, ordinary pipelines, flat lists, leading Bash assignments, fully extracted command substitutions, and one exact literal `cd DIR && COMMAND` transition. Every syntactically present unit must allow; the analyzer does not predict branches or execution order.

Control flow, shell scope, job control, generic wrapper unwrapping, embedded command languages, and runtime cwd or shell-state simulation are outside this model. Supporting one command must not introduce those general mechanisms.

### Complete recognition

A recognizer either accepts a complete invocation and emits all required facts, or returns unsupported. A rejected specific profile must not fall through to a broader profile. Path extraction is command-specific; the classifier never guesses that arbitrary arguments are paths.

### Typed facts

The stable fact model includes:

- visible read, write, delete, move-source, and move-destination effects;
- explicit situation-3 eligibility from a complete profile;
- `mutationScopes` for visible affected paths or ranges;
- `stabilityDependencies` for analysis-time prerequisites.

Adding instances of these facts is extensible. Adding a fact kind that changes classification or aggregation is architectural.

## 4. The three situations

The existence, meaning, and precedence of these situations are core invariants.

### 1. Clearly inside the workspace

A complete path recognizer has resolved every classification target inside the workspace. Cwd alone cannot place a path-free command here.

Apply exactly three red lines:

1. Ask for direct deletion, removal, or moving-away of the workspace root.
2. Ask for direct `.git` mutation through ordinary filesystem operations.
3. Ask for execution of a workspace entry script unless it satisfies the committed-and-unchanged baseline and the script profile's visible-argument checks.

Every other recognized workspace operation allows. No profile can override a red line.

For a direct script, only its entry path selects the situation. Argument screening belongs to the script red line and does not create a generic path-guessing layer.

### 2. Clearly outside the workspace

If any classification target of a recognized filesystem operation is external, the entire unit is outside. The analyzer does not split mixed source and destination operations to recover an allow.

Only finite recognized external reads allow. External writes and unsupported forms ask.

### 3. No workspace relationship, or indeterminate

This includes both recognized workspace-neutral operations and forms whose workspace relationship cannot be determined.

Only exact reviewed profiles allow. Everything else asks. Informational, network, Git, environment-assignment, and development-workflow support belongs here rather than being inferred from ambient cwd.

## 5. Source aggregation

The complete source allows only when:

1. bounded parsing and normalization succeed;
2. every relevant AST node is accounted for;
3. every decision unit allows under its own situation;
4. no `mutationScope` overlaps a `stabilityDependency`.

Equality and ancestor/descendant containment count as overlap. This comparison is order-independent and not Git-specific. The aggregator must not contain command-specific branches, allow one unit to override another unit's ask, or simulate runtime state.

## 6. Permission-gate boundary

OpenCode's `bash` and `external_directory` requests are independent gates, but both must use the same complete Bash policy. Neither is a relaxed path. Approval at one gate does not approve the other.

The `edit` permission is a separate path policy and does not enter the Bash three-situation model.

## 7. Extension contract

Ordinary extensions may add:

- complete command path recognizers using existing facts;
- finite external-read forms;
- exact situation-3 profiles and supported options;
- development workflows using an already approved trust predicate;
- conservative high-risk environment names;
- syntax normalization that maps mechanically to existing units and facts;
- performance, diagnostics, and internal refactors that preserve decisions.

An extension must preserve complete recognition, fail closed for unknown adjacent forms, emit all relevant visible effects and dependencies, avoid classifier or aggregator exceptions, and include profile-local allow and ask tests plus passing architecture-contract tests.

The exact current commands, flags, and control files are not architecture. They belong in `src/policy/profiles/`, with executable specification in `test/profiles/`.

## 8. Architecture changes

A change is architectural if it alters any product invariant, trust boundary, decision-unit boundary, fact kind, situation, red line, structural-coverage rule, or aggregation rule; reparses text currently treated as data; or adds execution-order, control-flow, filesystem-state, or shell-state simulation.

Before implementation it requires an explicitly approved decision record under `docs/architecture-decisions/` covering:

1. the frequent concrete problem;
2. why a normal profile extension cannot solve it;
3. affected invariants and trust boundaries;
4. alternatives, including leaving the form unsupported;
5. the new complexity and its explicit bound;
6. effects on all situations and aggregation;
7. fail-closed behavior and adversarial tests;
8. migration and documentation consequences;
9. why the resulting model remains self-consistent.

Supporting a command or fixing a test is not by itself an architecture rationale.

## 9. Contract tests

Architecture tests must remain separate from profile tests and permanently cover fail-closed parsing, full AST consumption, unsupported structures, independent unit classification, all-unit aggregation, the three situations and red lines, mixed inside/outside handling, cwd boundaries, stability conflicts, and the common policy shared by `bash` and `external_directory`.

Individual command tests may evolve with their profile. They must not redefine these contracts.
