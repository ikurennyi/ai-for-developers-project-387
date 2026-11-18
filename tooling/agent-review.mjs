// Trusted adapter only: never import candidate code or policy.
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { execFileSync } from "node:child_process"
import { github, collectBudget, trustedPullRequest, approvalValid } from "./agent-policy.mjs"

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
const maxContextBytes = 2 * 1024 * 1024
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
  const gaps = []
  async function optional(label, action) {
    try { return await action() } catch {
      gaps.push(`${label}: unavailable; do not infer success or approval`)
      return null
    }
  }
  const linked = /<!-- agent-context (\{[^\n]*\}) -->/u.exec(pr.body ?? "")
  let metadata
  try {
    metadata = linked ? JSON.parse(linked[1]) : null
  } catch { metadata = null }
  const validMetadata = metadata && Number.isSafeInteger(metadata.source) && metadata.source > 0 &&
    Number.isSafeInteger(metadata.spec) && metadata.spec > 0 &&
    Array.isArray(metadata.tickets) && metadata.tickets.length > 0 &&
    metadata.tickets.length <= 20 && metadata.tickets.every((id) => Number.isSafeInteger(id) && id > 0) &&
    new Set(metadata.tickets).size === metadata.tickets.length &&
    typeof metadata.approval === "string" &&
    new RegExp(`^https://github\\.com/${repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/issues/${metadata.source}#issuecomment-[1-9]\\d*$`, "u").test(metadata.approval)
  if (!validMetadata) gaps.push("Explicit source/spec/ticket/approval provenance is missing or invalid")
  const issues = []
  const approvals = []
  if (validMetadata) {
    for (const id of [metadata.source, metadata.spec, ...metadata.tickets]) {
      const issue = await optional(`Linked issue #${id}`, () => github(`${prefix}/issues/${id}`))
      const comments = issue
        ? await optional(`Discussion for linked issue #${id}`, () => github.paginate(`${prefix}/issues/${id}/comments`))
        : null
      if (issue && comments) issues.push({ issue, comments })
    }
    const approvalID = metadata.approval.match(/#issuecomment-([1-9]\d*)$/u)?.[1]
    const approval = await optional("Explicit approval comment", () => github(`${prefix}/issues/comments/${approvalID}`))
    if (approval && approvalValid(approval, { ...metadata, repo })) approvals.push(approval)
    else gaps.push("Explicit approval comment is unavailable or does not approve the linked scope")
  }
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
  if (!issues.length) gaps.push("Source/spec/ticket links missing or unavailable")
  if (!approvals.length) gaps.push("No explicit approval-comment evidence collected")
  if (!checks?.length && !statuses?.length) gaps.push("No CI evidence for reviewed SHA")
  const currentPR = await github(prPath)
  if (currentPR.head.sha !== state.sha || !trustedPullRequest(currentPR, repo, owner)) throw new Error("PR changed during context collection")
  const context = {
    sha: state.sha, pr: { number: pr.number, title: pr.title, html_url: pr.html_url },
    metadata: validMetadata ? metadata : null, diff, files, issues, approvals,
    checks, statuses, runs, gaps,
    note: "Only explicitly linked source/spec/tickets/approval, the PR diff and checks for this exact SHA are included. Approval must be verified against its source and exact scope."
  }
  let serialized = JSON.stringify(context, null, 2)
  if (Buffer.byteLength(serialized) > maxContextBytes) {
    const gap = `Complete review context exceeds the ${maxContextBytes}-byte limit; content omitted, verdict cannot claim successful verification`
    const limited = (items, maximum, label, project) => {
      if (!Array.isArray(items)) return null
      if (items.length > maximum) gaps.push(`${label} summary omits ${items.length - maximum} records`)
      return items.slice(0, maximum).map(project)
    }
    const summary = {
      sha: state.sha, pr: context.pr, metadata: validMetadata ? metadata : null,
      diff: null,
      files: limited(files, 100, "Changed-file", ({ filename, status, additions, deletions, changes }) =>
        ({ filename: String(filename).slice(0, 300), status, additions, deletions, changes })),
      issues: limited(issues, 22, "Linked-issue", ({ issue }) => ({
        issue: { number: issue.number, title: String(issue.title ?? "").slice(0, 200), html_url: issue.html_url }
      })),
      approvals: limited(approvals, 5, "Approval", ({ id, html_url, user }) =>
        ({ id, html_url, user: { login: user?.login, type: user?.type } })),
      checks: limited(checks, 100, "Check-run", ({ name, status, conclusion, details_url }) =>
        ({ name: String(name ?? "").slice(0, 200), status, conclusion, details_url: String(details_url ?? "").slice(0, 500) })),
      statuses: limited(statuses, 100, "Commit-status", ({ context: name, state, target_url }) =>
        ({ context: String(name ?? "").slice(0, 200), state, target_url: String(target_url ?? "").slice(0, 500) })),
      runs: limited(runs, 100, "Actions-run", ({ id, run_attempt, status, conclusion, html_url }) =>
        ({ id, run_attempt, status, conclusion, html_url })),
      gaps: [...gaps, gap],
      note: context.note
    }
    serialized = JSON.stringify(summary, null, 2)
  }
  fs.writeFileSync(path.join(root, "review-context.json"), serialized)
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
    if (process.env.MODEL_STARTED !== "true" ||
        process.env.CONTEXT_OUTCOME !== "success" || process.env.INSTALL_OUTCOME !== "success") {
      verdict = "infra"
    } else if (process.env.MODEL_VERDICT === "timeout") {
      verdict = "timeout"
    } else if (process.env.MODEL_VERDICT === "reviewed" &&
        process.env.MODEL_OUTCOME === "success" && fs.existsSync(result)) {
      body = fs.readFileSync(result, "utf8").trim()
    }
    if (!body && verdict === "allow") verdict = "agent_failed"
  }
  body = body || `No model review produced. Verdict: **${verdict}**. Human action required.`
  // Keep GitHub's comment limit explicit rather than silently cutting findings.
  if (body.length > 60000) body = "No publishable model review. Verdict: **agent_failed** (output exceeds comment limit)."
  execFileSync("gh", ["pr", "comment", number, "--repo", repo, "--body-file", "-"], {
    input: `<!-- independent-agent-review -->\nIndependent review at \`${state.sha}\`\n\n${body}\n\n[Actions logs](${logURL}). Review never authorizes fixes or another run.`,
    encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 30000
  })
}

const commands = { gate, context, publish }
if (!Object.hasOwn(commands, process.argv[2])) throw new Error("Expected gate, context or publish")
await commands[process.argv[2]]()
