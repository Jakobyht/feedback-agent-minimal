# Feedback Agent Minimal

Minimal pipeline:

```text
app feedback -> Supabase row -> GitHub issue -> strict local harness -> agent decision -> labels or PR
```

The repo contains two programs.

## 1. Supabase To GitHub Issue

Runs on Supabase.

Files:

```text
supabase/sql/feedback.sql
supabase/functions/feedback-to-issue/index.ts
```

Compute:

1. The app inserts a row into `public.feedback`.
2. Supabase sends the inserted row to the Edge Function.
3. The Edge Function checks whether the row already has a GitHub issue.
4. It searches GitHub for an issue containing the same feedback row ID.
5. If no issue exists, it creates one labeled `agent-ready`.
6. It writes the GitHub issue URL and number back to the feedback row.

App integration:

```js
await supabase.from("feedback").insert({
  message: feedbackMessage,
  page_url: location.pathname,
  user_email: user?.email ?? null
});
```

## 2. GitHub Issue Harness

Runs on the local machine that has the target app repo cloned.

File:

```text
local-agent/watch.js
```

Compute:

1. Ensure the required GitHub labels exist.
2. Poll GitHub for open issues labeled `agent-ready`.
3. Ignore issues that already have a final state label.
4. Move the issue to `agent-triaging`.
5. Start the agent with a prompt and a required `decision.json` path.
6. The agent may inspect the repo and may edit local files only if the feedback is an objective bug or docs issue.
7. The agent writes `decision.json`.
8. The harness validates `decision.json` and local file changes mechanically.
9. If valid and files changed, the harness creates a branch, commit, push, and pull request.
10. The harness applies the final type label, state label, and GitHub comment.

The agent judges. The harness enforces consequences.

## Labels

Type labels:

```text
type-bug
type-docs
type-question
type-subjective
type-business
```

State labels:

```text
agent-ready
agent-triaging
agent-done
agent-untrue
agent-info-only
agent-needs-human
duplicate
agent-failed
```

Allowed final combinations:

```text
type-bug        -> agent-done | agent-untrue | agent-needs-human | duplicate
type-docs       -> agent-done | agent-needs-human | duplicate
type-question   -> agent-info-only | agent-needs-human | duplicate
type-subjective -> agent-info-only | agent-needs-human | duplicate
type-business   -> agent-info-only | agent-needs-human | duplicate
```

Hard invariant:

```text
type-question, type-subjective, and type-business may not change files.
Only type-bug may set should_change_code=true.
type-docs may only change Markdown files or files inside docs/.
```

## Decision File

The agent must write:

```json
{
  "type": "type-bug",
  "state": "agent-done",
  "truth": "true",
  "should_change_code": true,
  "reason": "The button has no click handler on mobile.",
  "human_report": "I reproduced the issue and fixed the missing mobile click handler.",
  "checks_run": ["npm run lint", "npm run build"]
}
```

Allowed `truth` values:

```text
true
false
unclear
not_applicable
```

## Setup

Create the Supabase table:

```text
supabase/sql/feedback.sql
```

Deploy the Edge Function:

```bash
supabase functions deploy feedback-to-issue --no-verify-jwt
```

Set Supabase secrets:

```bash
supabase secrets set GITHUB_OWNER="your-github-user-or-org"
supabase secrets set GITHUB_REPO="your-app-repo"
supabase secrets set GITHUB_TOKEN="github-token-with-issues-write"
supabase secrets set WEBHOOK_SECRET="long-random-secret"
supabase secrets set SUPABASE_SERVICE_ROLE_KEY="your-supabase-service-role-key"
```

Create the Supabase Database Webhook:

```text
Table: feedback
Event: INSERT
Method: POST
URL: https://YOUR_PROJECT_REF.supabase.co/functions/v1/feedback-to-issue
Header: x-webhook-secret: same value as WEBHOOK_SECRET
```

Run the local harness:

```bash
npm install
GITHUB_OWNER="your-github-user-or-org" \
GITHUB_REPO="your-app-repo" \
GITHUB_TOKEN="github-token-with-issues-and-pr-write" \
AGENT_REPO="/absolute/path/to/your/local/app/repo" \
npm run watch
```

Default agent command:

```bash
codex exec "$(cat "$PROMPT_FILE")"
```

Override it:

```bash
AGENT_COMMAND='codex exec "$(cat "$PROMPT_FILE")"' npm run watch
```

## Check

```bash
npm run check
```
