const owner = required("GITHUB_OWNER");
const repo = required("GITHUB_REPO");
const token = required("GITHUB_TOKEN");
const secret = required("WEBHOOK_SECRET");

Deno.serve(async (request) => {
  if (request.method !== "POST") return response({ error: "method_not_allowed" }, 405);
  if (request.headers.get("x-webhook-secret") !== secret) return response({ error: "unauthorized" }, 401);

  const event = await request.json();
  const row = event.record;
  if (!row?.message) return response({ error: "missing_message" }, 422);

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
        `Feedback row: ${row.id || "not provided"}`
      ].join("\n"),
      labels: ["agent-ready"]
    })
  });

  if (!github.ok) return response({ error: await github.text() }, 502);
  const issue = await github.json();
  return response({ ok: true, issue: issue.html_url });
});

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
