import fs from "node:fs/promises";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

const owner = env("GITHUB_OWNER");
const repo = env("GITHUB_REPO");
const token = env("GITHUB_TOKEN");
const agentRepo = path.resolve(env("AGENT_REPO"));
const baseBranch = process.env.BASE_BRANCH || "main";
const pollMs = Number(process.env.POLL_MS || 60000);
const agentCommand = process.env.AGENT_COMMAND || 'codex exec "$(cat "$PROMPT_FILE")"';

const readyLabel = "agent-ready";
const triagingLabel = "agent-triaging";
const typeLabels = ["type-bug", "type-docs", "type-question", "type-subjective", "type-business"];
const stateLabels = ["agent-done", "agent-untrue", "agent-info-only", "agent-needs-human", "duplicate", "agent-failed"];
const requiredLabels = [
  { name: readyLabel, color: "0e8a16", description: "Ready for agent harness" },
  { name: triagingLabel, color: "fbca04", description: "Currently claimed by agent harness" },
  { name: "type-bug", color: "d73a4a", description: "Objective product defect" },
  { name: "type-docs", color: "0075ca", description: "Documentation feedback" },
  { name: "type-question", color: "d4c5f9", description: "Question, not a code request" },
  { name: "type-subjective", color: "cfd3d7", description: "Subjective or preference feedback" },
  { name: "type-business", color: "bfd4f2", description: "Business or pricing feedback" },
  { name: "agent-done", color: "0e8a16", description: "Harness accepted final work" },
  { name: "agent-untrue", color: "cfd3d7", description: "Reported bug was not true" },
  { name: "agent-info-only", color: "bfdadc", description: "Answered without file changes" },
  { name: "agent-needs-human", color: "fbca04", description: "Needs human decision" },
  { name: "duplicate", color: "cfd3d7", description: "Already handled elsewhere" },
  { name: "agent-failed", color: "b60205", description: "Agent or harness failed" }
];
const noFileChangeTypes = new Set(["type-question", "type-subjective", "type-business"]);
const allowedStates = {
  "type-bug": new Set(["agent-done", "agent-untrue", "agent-needs-human", "duplicate"]),
  "type-docs": new Set(["agent-done", "agent-needs-human", "duplicate"]),
  "type-question": new Set(["agent-info-only", "agent-needs-human", "duplicate"]),
  "type-subjective": new Set(["agent-info-only", "agent-needs-human", "duplicate"]),
  "type-business": new Set(["agent-info-only", "agent-needs-human", "duplicate"])
};

const stateDir = path.join(agentRepo, ".agent-state");
let polling = false;

await fs.mkdir(stateDir, { recursive: true });

console.log(`Heartbeat watching ${owner}/${repo} for ${readyLabel}`);
await ensureLabels();
await poll();
setInterval(() => poll().catch((error) => console.error(error)), pollMs);

async function poll() {
  if (polling) return;
  polling = true;

  try {
    for (const issue of await getIssues()) {
      await runIssue(issue);
    }
  } finally {
    polling = false;
  }
}

async function runIssue(issue) {
  await addLabel(issue.number, triagingLabel);
  await removeLabel(issue.number, readyLabel);
  await comment(issue.number, "Heartbeat claimed this issue.");

  const runDir = path.join(stateDir, `issue-${issue.number}`);
  await fs.mkdir(runDir, { recursive: true });

  const promptFile = path.join(runDir, "prompt.md");
  const decisionFile = path.join(runDir, "decision.json");
  const logFile = path.join(runDir, "agent.log");

  const dirtyBefore = await changedFiles();
  if (dirtyBefore.length > 0) {
    await finish(issue.number, "type-bug", "agent-needs-human", `Local repo is dirty before the agent starts:\n${dirtyBefore.join("\n")}`);
    return;
  }

  await git(["checkout", baseBranch]);
  await git(["pull", "--ff-only"]);

  await fs.writeFile(promptFile, formatPrompt(issue, decisionFile));

  const exitCode = await runAgent(promptFile, logFile);
  if (exitCode !== 0) {
    await finish(issue.number, "type-bug", "agent-failed", `Agent exited with code ${exitCode}. Local log: ${logFile}`);
    return;
  }

  const decision = await readDecision(decisionFile);
  const files = await changedFiles();
  const validation = validateDecision(decision, files);

  if (!validation.ok) {
    const safeType = typeLabels.includes(decision?.type) ? decision.type : "type-bug";
    await finish(issue.number, safeType, "agent-needs-human", [
      "Decision rejected by deterministic harness.",
      "",
      validation.reason,
      files.length ? `\nLocal changed files:\n${files.join("\n")}` : "",
      `\nLocal log: ${logFile}`
    ].join("\n"));
    return;
  }

  let prUrl = null;
  if (decision.state === "agent-done" && files.length > 0) {
    try {
      prUrl = await createPullRequest(issue, decision, files);
    } catch (error) {
      await finish(issue.number, decision.type, "agent-needs-human", `Could not create pull request: ${error.message}`);
      return;
    }
  }

  await finish(issue.number, decision.type, decision.state, formatReport(decision, prUrl, logFile));
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

async function createPullRequest(issue, decision, files) {
  const branch = `agent/issue-${issue.number}-${Date.now()}`;
  await git(["checkout", "-b", branch]);
  await git(["add", "--", ...files]);
  await git(["commit", "-m", `Handle feedback issue #${issue.number}`]);
  await git(["push", "-u", "origin", branch]);

  const body = [
    `Issue: ${issue.html_url}`,
    "",
    decision.human_report,
    "",
    "Checks:",
    ...decision.checks_run.map((check) => `- ${check}`)
  ].join("\n");

  const { stdout } = await exec("gh", [
    "pr",
    "create",
    "--repo",
    `${owner}/${repo}`,
    "--title",
    `Handle feedback #${issue.number}: ${issue.title}`.slice(0, 120),
    "--body",
    body
  ], { cwd: agentRepo, env: githubEnv() });

  await git(["checkout", baseBranch]);
  return stdout.trim();
}

async function changedFiles() {
  const { stdout } = await git(["status", "--porcelain"]);
  return stdout
    .split("\n")
    .map((line) => line.slice(3).trim())
    .filter(Boolean)
    .filter((file) => !file.startsWith(".agent-state/"));
}

async function git(args) {
  return await exec("git", args, { cwd: agentRepo, env: process.env });
}

async function readDecision(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

function validateDecision(decision, files) {
  if (!decision || typeof decision !== "object") return invalid("decision.json is missing or invalid JSON.");
  if (!typeLabels.includes(decision.type)) return invalid(`Invalid type: ${decision.type}`);
  if (!stateLabels.includes(decision.state)) return invalid(`Invalid state: ${decision.state}`);
  if (!allowedStates[decision.type].has(decision.state)) return invalid(`Invalid combination: ${decision.type} + ${decision.state}`);
  if (!["true", "false", "unclear", "not_applicable"].includes(decision.truth)) return invalid(`Invalid truth: ${decision.truth}`);
  if (typeof decision.should_change_code !== "boolean") return invalid("should_change_code must be boolean.");
  if (typeof decision.reason !== "string" || decision.reason.trim() === "") return invalid("reason is required.");
  if (typeof decision.human_report !== "string" || decision.human_report.trim() === "") return invalid("human_report is required.");
  if (!Array.isArray(decision.checks_run) || !decision.checks_run.every((item) => typeof item === "string")) return invalid("checks_run must be an array of strings.");

  if (decision.should_change_code && decision.type !== "type-bug") return invalid("Only type-bug may set should_change_code=true.");
  if (noFileChangeTypes.has(decision.type) && files.length > 0) return invalid(`${decision.type} may not change files.`);
  if (decision.type === "type-docs" && files.some((file) => !isDocsFile(file))) return invalid("type-docs may only change documentation files.");
  if (decision.state === "agent-done" && decision.type === "type-bug" && decision.truth !== "true") return invalid("type-bug + agent-done requires truth=true.");
  if (decision.state === "agent-untrue" && decision.truth !== "false") return invalid("agent-untrue requires truth=false.");
  if (decision.state === "agent-info-only" && (decision.should_change_code || files.length > 0)) return invalid("agent-info-only may not change files.");
  if (decision.state === "duplicate" && files.length > 0) return invalid("duplicate may not change files.");
  if (files.length > 0 && decision.checks_run.length === 0) return invalid("File changes require checks_run.");

  return { ok: true };
}

function invalid(reason) {
  return { ok: false, reason };
}

function isDocsFile(file) {
  return file.endsWith(".md") || file.startsWith("docs/");
}

async function finish(issueNumber, type, state, body) {
  await removeKnownLabels(issueNumber);
  await addLabel(issueNumber, type);
  await addLabel(issueNumber, state);
  await comment(issueNumber, body);
  console.log(`finished issue #${issueNumber}: ${type} ${state}`);
}

async function removeKnownLabels(issueNumber) {
  for (const label of [readyLabel, triagingLabel, ...typeLabels, ...stateLabels]) {
    await removeLabel(issueNumber, label);
  }
}

function formatReport(decision, prUrl, logFile) {
  return [
    decision.human_report,
    "",
    `Decision: ${decision.type} + ${decision.state}`,
    `Truth: ${decision.truth}`,
    `Code change allowed: ${decision.should_change_code}`,
    prUrl ? `Pull request: ${prUrl}` : null,
    decision.checks_run.length ? `Checks: ${decision.checks_run.join(", ")}` : "Checks: none",
    `Local log: ${logFile}`
  ].filter(Boolean).join("\n");
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
    return !labels.includes(triagingLabel) && !labels.some((label) => stateLabels.includes(label));
  });
}

async function ensureLabels() {
  for (const label of requiredLabels) {
    const result = await fetch(`https://api.github.com/repos/${owner}/${repo}/labels`, {
      method: "POST",
      headers: {
        ...githubHeaders(),
        "content-type": "application/json"
      },
      body: JSON.stringify(label)
    });

    if (!result.ok && result.status !== 422) throw new Error(await result.text());
  }
}

async function addLabel(issueNumber, label) {
  await github("POST", `/repos/${owner}/${repo}/issues/${issueNumber}/labels`, { labels: [label] });
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

function githubEnv() {
  return { ...process.env, GITHUB_TOKEN: token, GH_TOKEN: token };
}

function formatPrompt(issue, decisionFile) {
  return [
    `You are the judgment and coding agent for GitHub issue #${issue.number}.`,
    "",
    "You do not apply labels, push branches, open pull requests, or mark the issue done.",
    "The harness owns those consequences.",
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
    "Allowed type labels:",
    typeLabels.join(", "),
    "",
    "Allowed state labels:",
    stateLabels.join(", "),
    "",
    "Hard rule:",
    "type-question, type-subjective, and type-business may not change files.",
    "Only type-bug may set should_change_code=true.",
    "type-docs may only change Markdown or docs/ files.",
    "",
    "Your task:",
    "1. Inspect the issue and the local repository.",
    "2. Search existing issues, pull requests, and local documentation for already-handled feedback.",
    "3. If it is an objective bug and true, make the smallest local file change. Do not commit.",
    "4. If it is false, unclear, subjective, business feedback, or a question, do not change files.",
    "5. Run relevant checks if you changed files.",
    `6. Write exactly one JSON object to ${decisionFile}.`,
    "",
    "decision.json schema:",
    JSON.stringify({
      type: "type-bug",
      state: "agent-done",
      truth: "true",
      should_change_code: true,
      reason: "short internal reason",
      human_report: "clear GitHub comment for a human",
      checks_run: ["npm run lint", "npm run build"]
    }, null, 2)
  ].join("\n");
}

function env(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
