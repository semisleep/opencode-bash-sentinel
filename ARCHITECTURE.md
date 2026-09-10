# Architecture constitution

This document defines the stable product model, trust assumptions, decision pipeline, extension contract, and change-governance rules for `opencode-bash-sentinel`.

It is normative. [README.md](README.md) explains user-visible behavior, while [DEVELOPMENT.md](DEVELOPMENT.md) records the current profile registry, implementation plan, integration details, and tests. A current command profile may evolve within this constitution. A conflicting implementation or profile does not implicitly amend it.

## 1. Normative categories

The project uses five labels:

- **CORE INVARIANT:** part of the product or decision model. An ordinary feature, command addition, or bug fix must not change it.
- **ARCHITECTURE DECISION:** a deliberate boundary that keeps the model finite. Changing it requires the architecture-change process in section 10.
- **TRUST BOUNDARY:** an explicitly accepted limitation. It must not be described as a proved safety property.
- **EXTENSION POINT:** behavior that may grow without changing the model, subject to section 9.
- **CURRENT PROFILE:** the present finite list of accepted commands, options, and control files. It is expected to evolve.

“Stable” does not mean immutable forever. It means that only an explicit architecture decision may change the item; a local implementation convenience is not sufficient.

## 2. Product constitution

The following are **CORE INVARIANTS**:

1. Sentinel is a prompt-reduction tool for OpenCode, not a Bash sandbox or a general command-safety classifier.
2. Reducing roughly 70–80% of routine prompts is a successful outcome. Complete coverage is not a goal.
3. Automatic approval requires positive recognition of a finite supported form. Absence of a known-dangerous pattern is never sufficient.
4. Unknown, unsupported, ambiguous, partially recognized, or resource-exhausted input asks the user.
5. A harmless command that asks is an acceptable result. Expanding coverage is driven by frequent real-world prompts, not theoretical completeness.
6. Decisions are deterministic and local; permission classification does not depend on an LLM.

The fundamental direction is:

```text
recognized supported form -> evaluate documented policy
unknown or incomplete form -> ask
```

It must never become:

```text
no known danger found -> allow
```

## 3. Trust model

The following are **ARCHITECTURE DECISIONS** and **TRUST BOUNDARIES**:

- Sentinel analyzes submitted Bash syntax plus a small set of explicit facts such as the OpenCode cwd and Git state. It does not prove eventual runtime effects.
- Workspace containment is lexical. Filesystem-canonical symlink containment is not modeled.
- A bare executable name is not resolved to prove the identity selected by ambient `PATH`.
- A committed and unchanged workspace entry script is a trusted repository baseline. Its imports, sourced dependencies, configuration, generated inputs, and runtime behavior are opaque.
- A supported development workflow trusts only its documented direct control files. Hooks, transitive commands, source code executed by the workflow, runtime writes, and network effects are opaque.
- An approved `source FILE` or `. FILE` may change cwd, variables, functions, aliases, shell options, and the meaning of later commands. Those state changes are not simulated.
- Most Bash environment assignments are accepted. The short high-risk-name registry and documented tool-specific limitations define the current boundary; arbitrary environment semantics are not modeled.
- Approved network profiles are product trust decisions, not proof of remote read-only behavior or absence of data exposure.
- Analysis is not an atomic filesystem snapshot. Another process may change filesystem or Git state before execution.

Improving one of these boundaries may be valuable, but doing so is not an ordinary command-profile extension because it changes what the rest of the model may assume.

## 4. Normative decision pipeline

The following pipeline is a **CORE INVARIANT**:

```text
parse Bash once with explicit resource bounds
        |
        v
normalize supported structure and prove full relevant-node consumption
        |
        v
extract decision units
        |
        v
dispatch each unit to a finite complete-invocation recognizer
        |
        v
produce typed classification and composition facts
        |
        v
map each unit to exactly one of three situations
        |
        v
apply the rule for that situation
        |
        v
aggregate all units and check stability conflicts
        |
        +-- allow -> reply once
        |
        +-- ask   -> leave OpenCode's native dialog to the user
```

### 4.1 Structural completeness

Every execution- or I/O-relevant AST node must be explicitly consumed by supported normalization or make the complete source unsupported. Parser additions fail closed until the normalization layer handles or rejects the new node type.

Executable commands, redirects, and nested executable AST nodes such as command substitutions may become decision units. Strings interpreted only by another program are not recursively reparsed as Bash.

The initial supported composition subset is deliberately small:

- simple commands and redirects;
- ordinary pipelines;
- flat command lists joined by a newline, `;`, `&&`, or `||`;
- leading Bash assignments;
- one exact literal `cd DIR && COMMAND` transition, with the derived cwd applied only to that right-hand command; and
- command substitutions only when every inner executable node is extracted and the containing invocation remains completely recognized.

For a supported list or pipeline, normalization does not predict which branch or process runs: every syntactically present decision unit must allow. `if`, `for`, `while`, `until`, `case`, `select`, function definitions, background jobs, subshells, brace groups, process substitutions, and other structures requiring branch, scope, job-control, or shell-state analysis make the complete source unsupported in the initial model.

The cwd transition exception does not apply across `;`, newline, `||`, or a pipeline, because failure and subprocess semantics would make the right-hand cwd uncertain. A `cd` inside command substitution is unsupported initially. The workspace root remains the containment boundary; the OpenCode session directory is a separate initial cwd used only to resolve relative paths.

### 4.2 Complete recognition

A recognizer must either:

- accept the complete invocation shape and produce every fact required by the model; or
- return unsupported.

Partial recognition must not produce an allow. Rejection by a specific recognizer must not fall through to a broader rule for the same invocation.

Recognizers understand command syntax. The classifier does not independently guess that arbitrary arguments are paths.

### 4.3 Typed facts

Recognizers may produce facts from the stable model, including:

- read, write, delete, move, source, and destination paths;
- a situation-3 profile family;
- `mutationScopes`, covering directly visible paths or directory ranges that may be modified, removed, truncated, or moved;
- `stabilityDependencies`, covering paths whose analysis-time state is required for approval.

Adding a new fact kind that changes classification or source aggregation is an architecture change. Adding more instances of an existing fact kind is an extension.

## 5. Situation contract

The existence and meaning of these three situations are **CORE INVARIANTS**.

### 5.1 Clearly inside the workspace

A unit enters this situation only when a finite path recognizer accepts its complete form and all path operands that recognizer defines as classification targets resolve lexically inside the workspace. Ambient cwd alone does not place a path-free command here.

Path extraction is command-specific. For a supported direct script invocation, only the entry-script path selects the situation. The script red-line checker separately evaluates the visible arguments required by that profile; those arguments do not become generic classification targets or new cross-cutting fact types.

Apply the three workspace red lines:

1. Ask for direct deletion, removal, or moving-away of the workspace root.
2. Ask for direct modification of `.git` by ordinary filesystem operations. Git may maintain its own metadata through an allowed Git profile.
3. Ask for execution of a workspace entry script unless its documented committed-and-unchanged and visible-argument conditions hold.

No profile may override a red-line decision. Every other recognized situation-1 operation allows, including ordinary writes and deletion of workspace subpaths.

### 5.2 Clearly outside the workspace

If any relevant target of a recognized command is external, the whole command unit enters situation 2. The model does not split source and destination operations to recover extra allow cases.

Only finite recognized external-read forms allow. External writes and every unsupported form ask.

### 5.3 No workspace relationship, or indeterminate

This situation contains both recognized workspace-neutral operations and forms whose workspace relationship cannot be determined.

Only exact reviewed profiles allow. Everything else asks. Git, network commands, informational commands, and explicit development-workflow exceptions are represented here by current profiles rather than by inferred ambient workspace scope.

## 6. OpenCode permission-gate contract

OpenCode's `bash` and `external_directory` permissions are separate request gates, but both are governed by this same Bash policy architecture. An adapter for either gate must use the complete parse, normalization, recognition, three-situation, red-line, and source-aggregation pipeline. It must not introduce a relaxed `external_directory` policy or bypass any allow invariant.

Approval at one gate does not imply approval at the other. When OpenCode emits both requests for one command, Sentinel evaluates and replies to each request independently under the same model.

The `edit` permission is a separate path-based policy. It does not create Bash decision units, enter the three situations, or fall under the Bash command constitution in this document. Its current behavior may be documented for users and maintainers, but its long-term architecture will be decided separately.

## 7. Source aggregation contract

The complete Bash source allows only when all four **CORE INVARIANTS** hold:

1. parsing and supported normalization succeed;
2. every execution- or I/O-relevant AST node is accounted for;
3. every decision unit allows under its own situation;
4. no `mutationScope` overlaps any `stabilityDependency` in the same source.

Equality and ancestor/descendant coverage count as overlap. Stability-conflict comparison is deliberately order-independent. The aggregator does not simulate branches, runtime execution order, filesystem state transitions, or Shell state.

Git may currently establish the initial acceptability of a dependency, but the aggregation concept is not Git-specific. A future trust mechanism can use the same `stabilityDependencies` only after its trust assumptions have been explicitly approved.

The aggregator must not contain command-specific exceptions, allow one unit to override another unit's ask, or preserve cross-cutting confidence flags for a particular analyzer.

## 8. Deliberately unsupported semantic expansion

The following are **ARCHITECTURE DECISIONS**:

- Do not build a generic wrapper-unwrapping engine.
- Do not reinterpret `sh -c`, `eval`, `xargs`, `find -exec`, or similar embedded strings as nested Bash programs.
- Do not build a general-purpose positional-argument path guesser.
- Do not simulate arbitrary variables, functions, aliases, shell options, branches, loops, or runtime cwd state.
- Do not add control-flow, scope, job-control, or shell-state semantics merely to recognize one command inside an unsupported structural form. Such a widening of the composition model is an architecture change; parser coverage that maps mechanically to existing decision units and facts remains an extension.
- Do not recursively inspect scripts, package hooks, Git hooks, build graphs, or tool configuration.
- Do not add a second danger analyzer whose verdict is composed with the three-situation model.

An unsupported construct asks. Support for one high-frequency exact invocation may be proposed as a normal recognizer only when it maps completely to existing facts and does not introduce generic recursive semantics.

## 9. Extension contract

The following are **EXTENSION POINTS**:

- new complete-invocation path recognizers using existing fact types;
- new finite external-read forms;
- new exact situation-3 informational or network profiles;
- new Git subcommand/option forms within the existing Git situation-3 model;
- new development ecosystems and workflow forms using approved trust predicates;
- new supported flags or operand shapes for an existing profile;
- additions to the high-risk environment-variable registry;
- parser support for syntax that maps completely to existing decision units and facts;
- reasons, audit detail, performance improvements, and internal refactoring that preserve observable decisions and all invariants.

An extension must not:

- change unknown or unsupported from ask to allow;
- redefine a decision-unit boundary;
- introduce a new situation or alter situation precedence;
- weaken or bypass a workspace red line;
- let one unit override another unit's ask;
- change the all-units or stability-conflict aggregation rules;
- add command-specific branches to the classifier or aggregator;
- interpret an embedded language or add state/control-flow simulation;
- silently widen unknown options, operands, or subcommands;
- change a documented trust boundary.

### 9.1 Extension acceptance checklist

Every new or widened recognizer/profile must demonstrate that:

1. it fits an existing situation without changing situation semantics;
2. it accepts the complete invocation or returns unsupported;
3. every path operand and effect relevant to the model is represented;
4. its `mutationScopes` are complete for directly visible effects;
5. every analysis-time file prerequisite is represented by `stabilityDependencies`;
6. unknown flags, operands, and subcommands ask;
7. it neither overrides a red line nor adds classifier/aggregator special cases;
8. positive allow tests and adjacent unsafe/unknown ask tests are included;
9. invariant regression tests continue to pass;
10. the current profile registry and user-facing documentation are updated.

Adding a conservative denial, such as a new high-risk environment name, normally fits this process. Removing a denial or adding a materially riskier allowed behavior requires explicit policy review even when the architecture remains unchanged.

## 10. Architecture-change policy

A change is architectural if it changes a core invariant, architecture decision, trust boundary, decision-unit kind, fact kind, situation meaning, or aggregation rule. It must not be hidden inside a feature, profile addition, refactor, or bug fix.

Before implementation, an architecture change requires a written decision record under `docs/architecture-decisions/`, using that directory's template and containing:

1. the concrete, frequent problem the current model cannot solve;
2. why an ordinary recognizer/profile extension is insufficient;
3. the affected objective, assumption, invariant, and trust boundary;
4. at least two alternatives, including leaving the form unsupported;
5. the new state or complexity introduced and its explicit upper bound;
6. effects on every situation and on source aggregation;
7. the new fail-closed behavior;
8. counterexamples and adversarial tests;
9. migration and compatibility consequences;
10. synchronized updates to this constitution, README, development model, and tests;
11. an argument that the resulting model remains internally consistent.

The architecture decision must be explicitly approved before code changes rely on it. “Support command X” and “fix test Y” are not sufficient architecture rationales. A proposed record may document an unresolved design, but it must not be marked accepted without explicit maintainer approval.

### 10.1 Architectural-change test

If any answer below is yes, stop ordinary extension work and use the architecture-change process:

1. Does the change alter the default for unknown or unsupported input?
2. Does it alter what becomes a decision unit?
3. Does it reinterpret text that the current model treats as data?
4. Does it alter the three situations or their precedence?
5. Can one profile now override another unit or a red line?
6. Does it alter structural completeness, all-unit composition, or stability conflicts?
7. Does it add execution-order, control-flow, filesystem-state, or Shell-state simulation?
8. Does it change a trust assumption for scripts, workflows, environment, paths, executables, or network access?
9. Does a specific command require a new branch outside its recognizer/profile?

## 11. Current profile registry

The exact current command, option, environment-name, Git, network, and development-workflow sets are **CURRENT PROFILES**, not constitutional invariants. The registry belongs in [DEVELOPMENT.md](DEVELOPMENT.md) and is summarized for users in [README.md](README.md). A profile must be enumerated there before its implementation is treated as part of the target policy.

Their contents may evolve through the extension contract. Their placement in a situation and their interaction with the core invariants may not change through an ordinary profile edit.

The registry is expected to grow iteratively. It need not predict every future useful command, but each implemented allow form must be finite, exact, documented, and tested before it becomes part of the target policy.

## 12. Contract tests

Tests for individual commands may change with the registry. Separate architecture-contract tests must permanently exercise at least:

- unknown and partially recognized forms ask;
- parser errors, budgets, and unconsumed relevant AST nodes ask;
- no recognizer fallback after partial rejection;
- the supported composition subset is fully consumed, while unsupported control-flow and scope structures ask as complete sources;
- each unit is classified exactly once and every unit must allow;
- all three situation rules and their precedence;
- no situation-3 profile overrides a workspace red line;
- mixed inside/outside targets use situation 2;
- `bash` and `external_directory` adapters enforce the same policy invariants without treating either approval as approval of the other;
- overlapping mutation scopes and stability dependencies ask, whether they originate in the same or different decision units;
- non-overlapping scopes do not create a stability conflict;
- wrappers and embedded strings do not trigger recursive interpretation;
- classifier and aggregator results are independent of individual command names.

These tests protect the model from accidental architectural changes made while adding a command or fixing a local bug.
