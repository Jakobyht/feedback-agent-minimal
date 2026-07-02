import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const owner = env("GITHUB_OWNER");
const repo = env("GITHUB_REPO");
const token = env("GITHUB_TOKEN");
const agentRepo = path.resolve(env("AGENT_REPO"));
const label = process.env.GITHUB_LABEL || "agent-ready";
const pollMs = Number(process.env.POLL_MS || 60000);
const agentCommand = process.env.AGENT_COMMAND || 'claude -p "$(cat "$PROMPT_FILE")"';

const stateDir = path.join(agentRepo, ".agent-state");
const stateFile = path.join(stateDir, "processed.json");

await fs.mkdir(stateDir, { recursive: true });

console.log(`Watching ${owner}/${repo} for label ${label}`);
await poll();
setInterval(poll, pollMs);

async function poll() {
  const processed = await readJson(stateFile, []);
  const issues = await getIssues();

  for (const issue of issues) {
    if (processed.includes(issue.id)) continue;

    const promptFile = path.join(stateDir, `issue-${issue.number}.md`);
    await fs.writeFile(promptFile, formatPrompt(issue));

    spawn(agentCommand, {
      cwd: agentRepo,
      shell: true,
      detached: true,
      stdio: "ignore",
      env: { ...process.env, PROMPT_FILE: promptFile }
    }).unref();

    processed.push(issue.id);
    await fs.writeFile(stateFile, JSON.stringify(processed, null, 2));
    console.log(`started agent for issue #${issue.number}`);
  }
}

async function getIssues() {
  const url = new URL(`https://api.github.com/repos/${owner}/${repo}/issues`);
  url.searchParams.set("state", "open");
  url.searchParams.set("labels", label);

  const result = await fetch(url, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28"
    }
  });

  if (!result.ok) throw new Error(await result.text());
  return (await result.json()).filter((issue) => !issue.pull_request);
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

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

function env(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
