# Feedback Agent Minimal

Production-oriented feedback-to-agent pipeline.

```text
app -> Supabase feedback row -> GitHub issue -> Codex heartbeat -> PR or triage label
```

The system has two programs.

## Program 1: Supabase row to GitHub issue

Runs on Supabase.

Files:

```text
supabase/sql/feedback.sql
supabase/functions/feedback-to-issue/index.ts
```

Compute:

1. Your app inserts a row into `public.feedback`.
2. Supabase Database Webhook sends the inserted row to the Edge Function.
3. The Edge Function checks whether this feedback row already has a GitHub issue.
4. It also searches GitHub for an existing issue containing the same feedback row ID.
5. If no issue exists, it creates a GitHub issue labeled `agent-ready`.
6. It writes the created issue URL and issue number back to the Supabase row.

This makes webhook retries safer: if Supabase calls the function again for the
same feedback row, the function returns the existing issue instead of creating a
second one.

## Program 2: GitHub issue to Codex heartbeat

Runs on your laptop or Mac mini.

File:

```text
local-agent/watch.js
```

Compute:

1. Polls GitHub for open issues labeled `agent-ready`.
2. Ignores issues that already have a terminal or in-progress label.
3. Adds `agent-triaging`.
4. Removes `agent-ready`.
5. Writes a strict triage prompt to a local prompt file.
6. Starts Codex and waits for its exit code.
7. Codex inspects the issue and the local repository.
8. Codex searches existing GitHub issues, pull requests, and `unrealized-feedback.md` for already-handled feedback.
9. If the feedback was already fixed, documented, rejected, or tracked elsewhere, Codex links the earlier issue or pull request and marks the new issue `duplicate`.
10. If Codex can find the problem in the program, it changes code, runs checks, and opens a pull request.
11. If the feedback is subjective, a preference, a future idea, or not verifiable as a defect, Codex does not change product code. It opens a documentation-only pull request that adds the feedback to `unrealized-feedback.md`.
12. Codex can also ask clarification, ask for scope, mark duplicate, or request human review.
13. If Codex exits `0` without a final decision label, the heartbeat adds `needs-human-review`.
14. If Codex exits non-zero, the heartbeat adds `agent-failed`.

GitHub labels are the durable state machine:

```text
agent-ready -> agent-triaging -> agent-done
agent-ready -> agent-triaging -> needs-clarification
agent-ready -> agent-triaging -> needs-scope
agent-ready -> agent-triaging -> duplicate
agent-ready -> agent-triaging -> needs-human-review
agent-ready -> agent-triaging -> agent-failed
```

## Setup

### 1. Create the Supabase table

Open Supabase SQL Editor and run:

```text
supabase/sql/feedback.sql
```

### 2. Deploy the Supabase Edge Function

```bash
supabase functions deploy feedback-to-issue --no-verify-jwt
```

Set secrets:

```bash
supabase secrets set GITHUB_OWNER="your-github-user-or-org"
supabase secrets set GITHUB_REPO="your-app-repo"
supabase secrets set GITHUB_TOKEN="github-token-with-issues-write"
supabase secrets set WEBHOOK_SECRET="long-random-secret"
supabase secrets set SUPABASE_SERVICE_ROLE_KEY="your-supabase-service-role-key"
```

Supabase automatically provides `SUPABASE_URL` to Edge Functions.

The GitHub repo can be the same private repo that contains your app code.

Program 1 GitHub token:

```text
Repository access: only your app repo
Permissions: Issues read/write
```

It does not need code read/write access.

### 3. Create the Supabase Database Webhook

In Supabase:

```text
Database -> Webhooks -> Create webhook
```

Use:

```text
Table: feedback
Event: INSERT
Method: POST
URL: https://YOUR_PROJECT_REF.supabase.co/functions/v1/feedback-to-issue
Header: x-webhook-secret: same value as WEBHOOK_SECRET
```

### 4. Add feedback insert to your app

Your app only inserts a row:

```js
await supabase.from("feedback").insert({
  message: feedbackMessage,
  page_url: location.pathname,
  user_email: user?.email ?? null
});
```

Your app does not receive or store the GitHub token.

### 5. Run the local watcher

Install Node.js 20 or newer.

```bash
npm install
GITHUB_OWNER="your-github-user-or-org" \
GITHUB_REPO="your-app-repo" \
GITHUB_TOKEN="github-token-with-issues-write" \
AGENT_REPO="/absolute/path/to/your/local/app/repo" \
npm run watch
```

Program 2 needs issue write permission because it changes labels and posts
comments. If Codex will open pull requests, the machine also needs normal git
push permission for the repo.

Default agent command:

```bash
codex exec "$(cat "$PROMPT_FILE")"
```

Override it:

```bash
AGENT_COMMAND='claude -p "$(cat "$PROMPT_FILE")"' npm run watch
```

## Production guarantees

This repo provides:

1. Persistent source event: the Supabase `feedback` row.
2. Idempotency check: Product 1 checks `github_issue_url` before creating an issue.
3. Duplicate reduction: Product 1 searches GitHub for the feedback row ID before creating an issue.
4. Durable work queue: GitHub issues with labels.
5. Durable issue state: `agent-ready`, `agent-triaging`, `agent-done`, `agent-failed`, `needs-clarification`, `needs-scope`, `needs-human-review`, `duplicate`.
6. Same-issue safety: Product 2 ignores issues that already have a final state label, so one GitHub issue is not processed twice.
7. Same-feedback safety: Codex searches existing issues, pull requests, and `unrealized-feedback.md` before making a new change.
8. Evidence before code: Codex must inspect the repository and find an objective issue before editing product code.
9. Subjective feedback preservation: Codex stores subjective or unrealized feedback in `unrealized-feedback.md` through a documentation-only pull request.
10. Safer queue transition: Product 2 adds `agent-triaging` before removing `agent-ready`.
11. Post-condition check: after Codex exits, every issue must have a final decision label or `needs-human-review`.
12. Agent exit handling: Product 2 waits for the Codex process and records process failure.
13. No public Mac mini endpoint: the Mac mini makes outbound HTTPS requests to GitHub.

## Operational limits

This is production-oriented but intentionally small.

Known limits:

1. Run only one watcher per repo unless you add a stronger distributed lock.
2. If the Mac mini loses power while an issue has `agent-triaging`, an operator must inspect it and relabel it to `agent-ready` if it should retry.
3. If GitHub issue creation succeeds but the Supabase update fails, Product 1 searches GitHub for the existing feedback row ID on retry. This reduces duplicates, but GitHub search is not a formal cross-system transaction.
4. The agent itself is not sandboxed by this repo. Run it under a dedicated OS user and only give it access to the intended repo.

## Where compute runs

```text
App insert:
  user's browser CPU or app server CPU

Database write:
  Supabase Postgres CPU and disk

Webhook dispatch:
  Supabase infrastructure CPU

Issue creation:
  Supabase Edge Function CPU sends HTTPS request to GitHub API

Issue storage:
  GitHub server CPU and disk

Issue polling:
  Mac mini CPU sends HTTPS request to GitHub API

Prompt file:
  Mac mini CPU and disk

Codex process:
  Mac mini CPU
  GPU only if the selected agent runs a local GPU model
```

## Check code

```bash
npm run check
```
