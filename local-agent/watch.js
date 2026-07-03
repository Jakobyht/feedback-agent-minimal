import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const owner = env("GITHUB_OWNER");
const repo = env("GITHUB_REPO");
const token = env("GITHUB_TOKEN");
const agentRepo = path.resolve(env("AGENT_REPO"));
const readyLabel = process.env.GITHUB_READY_LABEL || "agent-ready";
const triagingLabel = process.env.GITHUB_TRIAGING_LABEL || "agent-triaging";
const runningLabel = process.env.GITHUB_RUNNING_LABEL || "agent-running";
const doneLabel = process.env.GITHUB_DONE_LABEL || "agent-done";
const failedLabel = process.env.GITHUB_FAILED_LABEL || "agent-failed";
const needsClarificationLabel = process.env.GITHUB_NEEDS_CLARIFICATION_LABEL || "needs-clarification";
const needsScopeLabel = process.env.GITHUB_NEEDS_SCOPE_LABEL || "needs-scope";
const needsHumanReviewLabel = process.env.GITHUB_NEEDS_HUMAN_REVIEW_LABEL || "needs-human-review";
const duplicateLabel = process.env.GITHUB_DUPLICATE_LABEL || "duplicate";
const pollMs = Number(process.env.POLL_MS || 60000);
const agentCommand = process.env.AGENT_COMMAND || 'codex exec "$(cat "$PROMPT_FILE")"';

const stateDir = path.join(agentRepo, ".agent-state");
let polling = false;

await fs.mkdir(stateDir, { recursive: true });

console.log(`Heartbeat watching ${owner}/${repo} for label ${readyLabel}`);
await poll();
setInterval(() => poll().catch((error) => console.error(error)), pollMs);

async function poll() {
  if (polling) return;
  polling = true;

  try {
    const issues = await getIssues();

    for (const issue of issues) {
      await runIssue(issue);
    }
  } finally {
    polling = false;
  }
}

async function runIssue(issue) {
  await addLabel(issue.number, triagingLabel);
  await removeLabel(issue.number, readyLabel);
  await comment(issue.number, "Heartbeat claimed this issue for Codex triage.");

  const runDir = path.join(stateDir, `issue-${issue.number}`);
  await fs.mkdir(runDir, { recursive: true });
  const promptFile = path.join(runDir, "prompt.md");
  const logFile = path.join(runDir, "agent.log");

  await fs.writeFile(promptFile, formatPrompt(issue));

  const exitCode = await runAgent(promptFile, logFile);

  await removeLabel(issue.number, triagingLabel);

  if (exitCode === 0) {
    const finalIssue = await getIssue(issue.number);
    const finalLabels = finalIssue.labels.map((label) => label.name);

    if (!hasTerminalLabel(finalLabels)) {
      await addLabel(issue.number, needsHumanReviewLabel);
      await comment(issue.number, `Codex exited successfully but did not leave a final decision label. Added ${needsHumanReviewLabel}. Local log: ${logFile}`);
      console.log(`heartbeat needs human review for issue #${issue.number}`);
      return;
    }

    await comment(issue.number, `Heartbeat finished. Local log: ${logFile}`);
    console.log(`heartbeat finished issue #${issue.number}`);
    return;
  }

  await addLabel(issue.number, failedLabel);
  await comment(issue.number, `Agent failed with exit code ${exitCode}. Local log: ${logFile}`);
  console.error(`agent failed issue #${issue.number} with exit code ${exitCode}`);
}

async function runAgent(promptFile, logFile) {
  const log = await fs.open(logFile, "a");

  return await new Promise((resolve, reject) => {
    const child = spawn(agentCommand, {
      cwd: agentRepo,
      shell: true,
      stdio: ["ignore", log.fd, log.fd],
      env: { ...process.env, PROMPT_FILE: promptFile }
    });

    child.on("error", reject);
    child.on("close", async (code) => {
      await log.close();
      resolve(code ?? 1);
    });
  });
}

async function getIssues() {
  const url = new URL(`https://api.github.com/repos/${owner}/${repo}/issues`);
  url.searchParams.set("state", "open");
  url.searchParams.set("labels", readyLabel);
  url.searchParams.set("per_page", "20");

  const result = await github("GET", `${url.pathname}${url.search}`);
  return result.filter((issue) => {
    if (issue.pull_request) return false;
    const labels = issue.labels.map((label) => label.name);
    return !labels.includes(triagingLabel) && !labels.includes(runningLabel) && !hasTerminalLabel(labels);
  });
}

async function getIssue(issueNumber) {
  return await github("GET", `/repos/${owner}/${repo}/issues/${issueNumber}`);
}

function hasTerminalLabel(labels) {
  return labels.includes(doneLabel) ||
    labels.includes(failedLabel) ||
    labels.includes(needsClarificationLabel) ||
    labels.includes(needsScopeLabel) ||
    labels.includes(needsHumanReviewLabel) ||
    labels.includes(duplicateLabel);
}

async function addLabel(issueNumber, label) {
  await github("POST", `/repos/${owner}/${repo}/issues/${issueNumber}/labels`, {
    labels: [label]
  });
}

async function removeLabel(issueNumber, label) {
  const encoded = encodeURIComponent(label);
  const result = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/labels/${encoded}`, {
    method: "DELETE",
    headers: githubHeaders()
  });

  if (!result.ok && result.status !== 404) throw new Error(await result.text());
}

async function comment(issueNumber, body) {
  await github("POST", `/repos/${owner}/${repo}/issues/${issueNumber}/comments`, { body });
}

async function github(method, path, body) {
  const result = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      ...githubHeaders(),
      ...(body ? { "content-type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });

  if (!result.ok) throw new Error(await result.text());
  if (result.status === 204) return null;
  return await result.json();
}

function githubHeaders() {
  return {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28"
  };
}

function formatPrompt(issue) {
  return [
    `You are the Codex heartbeat worker for GitHub issue #${issue.number}.`,
    "",
    "Repository:",
    `${owner}/${repo}`,
    "",
    "Issue URL:",
    issue.html_url,
    "",
    "Title:",
    issue.title,
    "",
    "Body:",
    issue.body || "",
    "",
    "Required behavior:",
    "1. Inspect the issue and the local repository.",
    "2. Decide exactly one outcome:",
    `   - actionable: implement the fix on a branch, run checks, open a pull request, comment with the PR URL, remove ${triagingLabel}, add ${doneLabel}.`,
    `   - unclear: ask a specific question, remove ${triagingLabel}, add ${needsClarificationLabel}.`,
    `   - too broad: explain the smaller needed scope, remove ${triagingLabel}, add ${needsScopeLabel}.`,
    `   - duplicate: link the existing issue or PR, remove ${triagingLabel}, add ${duplicateLabel}.`,
    `   - unsafe or risky: explain the risk, remove ${triagingLabel}, add ${needsHumanReviewLabel}.`,
    "",
    "Rules:",
    "- Do not push to main.",
    "- Do not make code changes unless the issue is actionable.",
    "- Prefer a small PR over a broad rewrite.",
    "- Leave a GitHub comment explaining the decision.",
    "- Use GitHub CLI if available for labels, comments, branches, and PRs."
  ].join("\n");
}

function env(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
