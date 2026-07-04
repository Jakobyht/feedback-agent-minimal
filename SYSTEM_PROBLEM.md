# System Problem

User feedback is untrusted input.

It may be true, false, unclear, subjective, business-related, duplicated, or unsafe. A coding agent can understand and investigate this input, but it must not receive unrestricted authority to convert any sentence into code changes.

The minimal system separates two jobs:

```text
agent   = judgment + local editing
harness = policy + labels + consequences
```

The agent may inspect the issue, inspect the repository, reason about the feedback, run checks, and edit local files when allowed.

The harness does not understand the feedback. It enforces allowed consequences.

## Core Invariant

```text
business/question/subjective feedback may not change files
```

This is enforced by deterministic code, not by prompt trust.

## Minimal Data Model

Every handled issue receives exactly one type label and one final state label.

Type labels:

```text
type-bug
type-docs
type-question
type-subjective
type-business
```

Final state labels:

```text
agent-done
agent-untrue
agent-info-only
agent-needs-human
duplicate
agent-failed
```

Allowed type-to-state combinations:

```text
type-bug        -> agent-done | agent-untrue | agent-needs-human | duplicate
type-docs       -> agent-done | agent-needs-human | duplicate
type-question   -> agent-info-only | agent-needs-human | duplicate
type-subjective -> agent-info-only | agent-needs-human | duplicate
type-business   -> agent-info-only | agent-needs-human | duplicate
```

Allowed file changes:

```text
type-bug        -> may change files and may set should_change_code=true
type-docs       -> may change only Markdown files or docs/ files
type-question   -> may not change files
type-subjective -> may not change files
type-business   -> may not change files
```

## Agent Output

The agent must write one machine-readable file:

```json
{
  "type": "type-bug",
  "state": "agent-done",
  "truth": "true",
  "should_change_code": true,
  "reason": "The click handler is missing on mobile.",
  "human_report": "I found and fixed the missing mobile click handler.",
  "checks_run": ["npm run lint", "npm run build"]
}
```

The harness validates:

```text
schema
allowed type labels
allowed state labels
allowed type/state pair
truth value
whether code changes are allowed
whether changed files match the type
whether checks were run for file changes
```

If validation passes, the harness applies the consequences:

```text
labels
GitHub comment
pull request, if files changed
```

If validation fails, the harness does not mark the issue done. It labels the issue:

```text
agent-needs-human
```

## Why This Is Minimal

Supabase only turns feedback rows into GitHub issues.

The agent only judges and edits locally.

The harness only validates and applies consequences.

No part of the system needs to solve a larger problem than that.
