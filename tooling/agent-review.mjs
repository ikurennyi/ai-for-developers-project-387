// Trusted adapter only: never import candidate code or policy.
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { github, collectBudget, trustedPullRequest } from "./agent-policy.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const statePath = path.join(root, "review-state.json")
const repo = process.env.GH_REPO
const number = process.env.REVIEW_PR
if (!/^[^/]+\/[^/]+$/.test(repo ?? "") || !/^[1-9]\d*$/.test(number ?? "")) {
  throw new Error("Invalid review repository or PR")
}
const prefix = `repos/${repo}`
const prPath = `${prefix}/pulls/${number}`
const owner = repo.split("/")[0]
const readState = () => JSON.parse(fs.readFileSync(statePath, "utf8"))
const save = (state) => fs.writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 })
const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"))
const logURL = `https://github.com/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`

async function gate() {
  const pr = await github(prPath)
  const state = { number: Number(number), sha: pr.head?.sha, decision: "infra" }
  save(state)
  const manual = process.env.GITHUB_EVENT_NAME === "workflow_dispatch"
  if (manual && (process.env.GITHUB_ACTOR !== owner ||
      process.env.GITHUB_REF_NAME !== event.repository?.default_branch)) return
  if (!manual && process.env.GITHUB_EVENT_NAME !== "pull_request") return
  if (!trustedPullRequest(pr, repo, owner) || pr.draft) return
  // An older queued event must not review a newer head under its old attribution.
  if (!manual && event.pull_request?.head?.sha !== state.sha) return
  state.publishAllowed = true
  save(state)
  const budget = await collectBudget({
    api: github, repo,
    current: { id: Number(process.env.GITHUB_RUN_ID), run_attempt: Number(process.env.GITHUB_RUN_ATTEMPT) },
    mode: "review", scope: `pr-${number}`, workflowPath: ".github/workflows/agent-review.yml"
  })
  Object.assign(state, budget)
  save(state)
  fs.appendFileSync(process.env.GITHUB_OUTPUT,
    `run=${budget.decision === "allow"}\nsha=${state.sha}\n`)
}

async function context() {
  const state = readState()
  const pr = await github(prPath)
  if (pr.head.sha !== state.sha || !trustedPullRequest(pr, repo, owner)) throw new Error("Stale or untrusted PR")
  // OpenCode checks external_directory against canonical absolute boundaries,
  // not paths relative to the agent file. Resolve only our fixed checkout.
  const candidate = fs.realpathSync(path.join(root, "..", "candidate"))
  const agentPath = path.join(root, ".opencode/agents/github-review.md")
  fs.writeFileSync(agentPath, fs.readFileSync(agentPath, "utf8")
    .replace("__CANDIDATE_DIRECTORY__", candidate))
  const gaps = []
  async function optional(label, action) {
    try { return await action() } catch {
      gaps.push(`${label}: unavailable; do not infer success or approval`)
      return null
    }
  }
  const comments = await github.paginate(`${prefix}/issues/${number}/comments`)
  const reviews = await github.paginate(`${prPath}/reviews`)
  const reviewComments = await github.paginate(`${prPath}/comments`)
  const files = await github.paginate(`${prPath}/files`)
  const diff = await optional("Full PR diff", async () => {
    const response = await fetch(`https://api.github.com/${prPath}`, {
      headers: {
        Accept: "application/vnd.github.diff",
        Authorization: `Bearer ${process.env.GH_TOKEN}`,
        "X-GitHub-Api-Version": "2022-11-28"
      },
      signal: AbortSignal.timeout(30000)
    })
    if (!response.ok) throw new Error("Diff unavailable")
    return response.text()
  })
  if (files.length !== pr.changed_files) gaps.push("GitHub file list is incomplete; diff coverage is not proven")
  if (files.some((f) => f.status !== "removed" && !f.patch)) gaps.push("Some patches are omitted/binary; inspect candidate source and report unavailable base/diff evidence")
  const checks = await optional("CI checks", () => github.paginate(`${prefix}/commits/${state.sha}/check-runs`, "check_runs"))
  const statuses = await optional("Commit statuses", () => github.paginate(`${prefix}/commits/${state.sha}/statuses`))
  const runs = await optional("Actions runs", () => github.paginate(`${prefix}/actions/runs?head_sha=${state.sha}`, "workflow_runs"))
  const issues = []
  const approvals = []
  const seen = new Set([Number(number)])
  const commentIDs = new Set()
  const queue = []
  function discover(text) {
    // Resolve only explicit same-repository issue links/#references. Never fetch
    // arbitrary URLs from attacker-controlled PR text.
    const escapedRepo = repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const links = new RegExp(`https://github\\.com/${escapedRepo}/issues/(\\d+)(?:#issuecomment-(\\d+))?`, "g")
    for (const match of text.matchAll(links)) {
      queue.push(Number(match[1]))
      if (match[2]) commentIDs.add(match[2])
    }
    for (const match of text.matchAll(/(?:^|[\s(])#([1-9]\d*)\b/g)) queue.push(Number(match[1]))
  }
  discover([pr.body, ...comments.map((c) => c.body)].join("\n"))
  while (queue.length) {
    const id = queue.shift()
    if (seen.has(id)) continue
    if (issues.length >= 40) { gaps.push("Linked context exceeds 40 issues; remaining context not collected"); break }
    seen.add(id)
    const issue = await optional(`Issue #${id}`, () => github(`${prefix}/issues/${id}`))
    if (!issue) continue
    const discussion = await optional(`Issue #${id} full discussion`, () => github.paginate(`${prefix}/issues/${id}/comments`))
    issues.push({ issue, comments: discussion })
    discover([issue.body, ...(discussion ?? []).map((c) => c.body)].join("\n"))
  }
  for (const id of commentIDs) {
    const comment = await optional(`Approval comment ${id}`, () => github(`${prefix}/issues/comments/${id}`))
    if (comment) approvals.push(comment)
  }
  if (!issues.length) gaps.push("Source/spec/ticket links missing or unavailable")
  if (!approvals.length) gaps.push("No explicit approval-comment evidence collected")
  if (!checks?.length && !statuses?.length) gaps.push("No CI evidence for reviewed SHA")
  const currentPR = await github(prPath)
  if (currentPR.head.sha !== state.sha || !trustedPullRequest(currentPR, repo, owner)) throw new Error("PR changed during context collection")
  fs.writeFileSync(path.join(root, "review-context.json"), JSON.stringify({
    sha: state.sha, pr, comments, reviews, reviewComments, diff, files, issues, approvals,
    checks, statuses, runs, gaps,
    note: "Approval comments are evidence, not automatic approval. Verify human author, exact scope and source discussion."
  }, null, 2))
}

async function publish() {
  const state = readState()
  if (!state.publishAllowed) return
  if (process.env.JOB_STATUS === "cancelled") return
  const pr = await github(prPath)
  if (!trustedPullRequest(pr, repo, owner) || pr.head.sha !== state.sha) return
  let verdict = state.decision
  let body
  if (verdict === "allow") {
    const result = path.join(process.env.RUNNER_TEMP, "agent-review.md")
    if (process.env.MODEL_OUTCOME === "success" && fs.existsSync(result)) {
      body = fs.readFileSync(result, "utf8").trim()
    }
    if (!body) verdict = "agent_failed"
  }
  body = body || `No model review produced. Verdict: **${verdict}**. Human action required.`
  // Keep GitHub's comment limit explicit rather than silently cutting findings.
  if (body.length > 60000) body = "No publishable model review. Verdict: **agent_failed** (output exceeds comment limit)."
  await github(`${prefix}/issues/${number}/comments`, {
    method: "POST", body: JSON.stringify({
      body: `<!-- independent-agent-review -->\nIndependent review at \`${state.sha}\`\n\n${body}\n\n[Actions logs](${logURL}). Review never authorizes fixes or another run.`
    }),
    headers: { "Content-Type": "application/json" }
  })
}

const commands = { gate, context, publish }
if (!Object.hasOwn(commands, process.argv[2])) throw new Error("Expected gate, context or publish")
await commands[process.argv[2]]()
