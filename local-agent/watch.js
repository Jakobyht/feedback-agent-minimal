import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const owner = env("GITHUB_OWNER");
const repo = env("GITHUB_REPO");
const token = env("GITHUB_TOKEN");
const agentRepo = path.resolve(env("AGENT_REPO"));
const readyLabel = process.env.GITHUB_READY_LABEL || "agent-ready";
const runningLabel = process.env.GITHUB_RUNNING_LABEL || "agent-running";
const doneLabel = process.env.GITHUB_DONE_LABEL || "agent-done";
const failedLabel = process.env.GITHUB_FAILED_LABEL || "agent-failed";
const pollMs = Number(process.env.POLL_MS || 60000);
const agentCommand = process.env.AGENT_COMMAND || 'claude -p "$(cat "$PROMPT_FILE")"';

const stateDir = path.join(agentRepo, ".agent-state");
let polling = false;

await fs.mkdir(stateDir, { recursive: true });

console.log(`Watching ${owner}/${repo} for label ${readyLabel}`);
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
  await removeLabel(issue.number, readyLabel);
  await addLabel(issue.number, runningLabel);
  await comment(issue.number, "Agent started on local machine.");

  const runDir = path.join(stateDir, `issue-${issue.number}`);
  await fs.mkdir(runDir, { recursive: true });
  const promptFile = path.join(runDir, "prompt.md");
  const logFile = path.join(runDir, "agent.log");

  await fs.writeFile(promptFile, formatPrompt(issue));

  const exitCode = await runAgent(promptFile, logFile);

  await removeLabel(issue.number, runningLabel);

  if (exitCode === 0) {
    await addLabel(issue.number, doneLabel);
    await comment(issue.number, `Agent finished successfully. Local log: ${logFile}`);
    console.log(`agent finished issue #${issue.number}`);
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
  return result.filter((issue) => !issue.pull_request);
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
    `Fix GitHub issue #${issue.number}: ${issue.title}`,
    "",
    issue.html_url,
    "",
    issue.body || ""
  ].join("\n");
}

function env(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
