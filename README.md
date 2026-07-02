# Feedback Agent Minimal

Minimal feedback-to-agent pipeline.

```text
app -> Supabase feedback row -> GitHub issue -> local watcher -> coding agent
```

There are two small programs.

## Program 1: Supabase row to GitHub issue

Runs on Supabase.

Files:

```text
supabase/sql/feedback.sql
supabase/functions/feedback-to-issue/index.ts
```

What it does:

1. Your app inserts a row into `public.feedback`.
2. Supabase Database Webhook calls the Edge Function.
3. The Edge Function creates a GitHub issue.
4. The issue gets the label `agent-ready`.

## Program 2: GitHub issue to local agent

Runs on your laptop or Mac mini.

File:

```text
local-agent/watch.js
```

What it does:

1. Polls GitHub for open issues labeled `agent-ready`.
2. Writes the issue text to a local prompt file.
3. Starts your coding agent with that prompt file.
4. Records the issue ID so it is not started twice.

## Setup

### 1. Create the Supabase table

Open Supabase SQL Editor and run:

```sql
create table if not exists public.feedback (
  id uuid primary key default gen_random_uuid(),
  message text not null,
  page_url text,
  user_email text,
  created_at timestamptz not null default now()
);
```

Or paste the contents of:

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
```

The GitHub repo can be the same private repo that contains your app code.
The token only needs issue permissions for Program 1.

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

### 5. Run the local watcher

Install Node.js 20 or newer.

```bash
npm install
GITHUB_OWNER="your-github-user-or-org" \
GITHUB_REPO="your-app-repo" \
GITHUB_TOKEN="github-token-with-issues-read" \
AGENT_REPO="/absolute/path/to/your/local/app/repo" \
npm run watch
```

Default agent command:

```bash
claude -p "$(cat "$PROMPT_FILE")"
```

Override it:

```bash
AGENT_COMMAND='codex exec "$(cat "$PROMPT_FILE")"' npm run watch
```

## Minimal correctness

This system is correct if:

1. Every valid inserted feedback row creates a GitHub issue.
2. Every unprocessed `agent-ready` issue starts one local agent process.
3. Processed issue IDs are persisted locally so they are not started twice.

## Where compute runs

```text
App insert: user's browser or app server CPU
Database write: Supabase Postgres CPU and disk
Issue creation: Supabase Edge Function CPU, then GitHub API
Issue polling: your laptop/Mac mini CPU, then GitHub API
Agent process: your laptop/Mac mini CPU; GPU only if your agent uses a local GPU model
```

The Mac mini does not need a public domain. It makes outgoing HTTPS requests to
GitHub.
