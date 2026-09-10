# Architecture decision records

Use this directory only for proposed or accepted changes to the stable model in [ARCHITECTURE.md](../../ARCHITECTURE.md). Adding or widening a command profile within the extension contract does not require a record.

Name records sequentially, for example `0001-example-title.md`. A proposal must remain `proposed` until explicitly approved by a maintainer.

## Template

```markdown
# ADR-NNNN: Short decision title

- Status: proposed | accepted | rejected | superseded
- Date: YYYY-MM-DD
- Supersedes: none

## Problem

Describe the concrete, frequent problem that the current model cannot solve.

## Why an extension is insufficient

Explain why a normal recognizer or profile cannot solve it without changing the architecture constitution.

## Affected contract

List every affected product objective, core invariant, architecture decision, trust boundary, decision-unit/fact type, situation, and aggregation rule.

## Alternatives

Include at least two alternatives, one of which is leaving the form unsupported.

## Decision

Describe the proposed model precisely.

## Complexity bound

List all new state or semantic analysis and state its explicit upper bound.

## Fail-closed behavior

Define what happens for unknown, partial, ambiguous, malformed, or resource-exhausted input.

## Cross-model consistency

Explain the effect on all three situations, structural completeness, red lines, unit composition, stability conflicts, and documented trust assumptions.

## Counterexamples and tests

Provide positive cases, adjacent rejected cases, adversarial cases, and architecture-contract regressions.

## Migration and compatibility

Describe code, data, behavior, and released-version consequences.

## Documentation updates

List required changes to ARCHITECTURE.md, README.md, DEVELOPMENT.md, AGENTS.md, and tests.

## Approval

Record the explicit maintainer decision. Implementation must not rely on this ADR while its status is `proposed`.
```
