const owner = required("GITHUB_OWNER");
const repo = required("GITHUB_REPO");
const token = required("GITHUB_TOKEN");
const secret = required("WEBHOOK_SECRET");
const supabaseUrl = required("SUPABASE_URL");
const serviceRoleKey = required("SUPABASE_SERVICE_ROLE_KEY");

Deno.serve(async (request) => {
  if (request.method !== "POST") return response({ error: "method_not_allowed" }, 405);
  if (request.headers.get("x-webhook-secret") !== secret) return response({ error: "unauthorized" }, 401);

  let event;
  try {
    event = await request.json();
  } catch {
    return response({ error: "invalid_json" }, 400);
  }
  const row = event.record;
  if (!row?.id || !row?.message) return response({ error: "missing_feedback_row" }, 422);

  const current = await getFeedbackRow(row.id);
  if (current.github_issue_url) {
    return response({ ok: true, skipped: "already_created", issue: current.github_issue_url });
  }

  const existing = await findExistingIssue(row.id);
  if (existing) {
    await updateFeedbackRow(row.id, {
      status: "github_issue_created",
      github_issue_url: existing.html_url,
      github_issue_number: existing.number,
      github_error: null
    });
    return response({ ok: true, skipped: "found_existing", issue: existing.html_url });
  }

  const github = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28"
    },
    body: JSON.stringify({
      title: `Feedback: ${oneLine(row.message).slice(0, 70)}`,
      body: [
        row.message,
        "",
        `Page: ${row.page_url || "not provided"}`,
        `User: ${row.user_email || "not provided"}`,
        `Feedback row: ${row.id}`
      ].join("\n"),
      labels: ["agent-ready"]
    })
  });

  if (!github.ok) {
    const error = await github.text();
    await updateFeedbackRow(row.id, { status: "github_failed", github_error: error });
    return response({ error }, 502);
  }

  const issue = await github.json();
  await updateFeedbackRow(row.id, {
    status: "github_issue_created",
    github_issue_url: issue.html_url,
    github_issue_number: issue.number,
    github_error: null
  });

  return response({ ok: true, issue: issue.html_url });
});

async function findExistingIssue(feedbackId: string) {
  const query = new URLSearchParams({
    q: `repo:${owner}/${repo} type:issue in:body "Feedback row: ${feedbackId}"`
  });

  const result = await fetch(`https://api.github.com/search/issues?${query}`, {
    headers: githubHeaders()
  });

  if (!result.ok) throw new Error(await result.text());

  const search = await result.json();
  return search.items?.[0] || null;
}

async function getFeedbackRow(id: string) {
  const result = await fetch(`${supabaseUrl}/rest/v1/feedback?id=eq.${encodeURIComponent(id)}&select=id,github_issue_url`, {
    headers: authHeaders()
  });

  if (!result.ok) throw new Error(await result.text());
  const rows = await result.json();
  return rows[0] || {};
}

async function updateFeedbackRow(id: string, patch: Record<string, unknown>) {
  const result = await fetch(`${supabaseUrl}/rest/v1/feedback?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: {
      ...authHeaders(),
      "content-type": "application/json",
      prefer: "return=minimal"
    },
    body: JSON.stringify(patch)
  });

  if (!result.ok) throw new Error(await result.text());
}

function authHeaders() {
  return {
    apikey: serviceRoleKey,
    authorization: `Bearer ${serviceRoleKey}`
  };
}

function githubHeaders() {
  return {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28"
  };
}

function required(name: string) {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function oneLine(value: string) {
  return value.replace(/\s+/g, " ").trim();
}
