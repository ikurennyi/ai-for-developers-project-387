import { test } from "node:test"
import assert from "node:assert/strict"
import { approvalValid, budgetDecision, collectBudget, protectedPath, routeCommand, trustedPullRequest, verifiedArtifact } from "../tooling/agent-policy.mjs"

const event = (body, pr = false, type = "User") => ({
  action: "created",
  repository: { full_name: "owner/repo", owner: { login: "owner" } },
  issue: { number: 8, ...(pr ? { pull_request: {} } : {}) },
  comment: { body, user: { login: "owner", type }, author_association: "OWNER" }
})

test("only an explicit whole-comment request grants implementation; source ids are not hardcoded", () => {
  assert.deepEqual(routeCommand(event("/oc implement-spec #42 tickets #43,#44 approval https://github.com/owner/repo/issues/8#issuecomment-99")), {
    mode: "implement", spec: 42, tickets: [43, 44],
    approval: "https://github.com/owner/repo/issues/8#issuecomment-99"
  })
  for (const body of ["/oc implement-spec", "/oc explain implement-spec #42", "> /oc implement-spec #42", "/oc to-spec"]) {
    assert.equal(routeCommand(event(body)).mode, "discussion")
  }
  assert.equal(routeCommand(event("/oc fix\nИсправь ошибку", true)).mode, "fix")
  assert.equal(routeCommand(event("/oc fix\nИсправь ошибку", true, "Bot")).mode, "discussion")
  assert.equal(routeCommand(event("/oc fix", false)).mode, "discussion")
})

const workflowPath = ".github/workflows/implement-spec.yml"
const run = (id, attempt = 1, mode = "interactive", scope = "pr-8") => ({
  id, run_attempt: attempt, path: workflowPath, scope, mode, admitted: true
})
const budget = (runs, id, attempt = 1, overrides = {}) => budgetDecision({
  runs, current: { id, run_attempt: attempt }, mode: "interactive",
  scope: "pr-8", workflowPath, historyComplete: true, ...overrides
})
test("three attempts are allowed, fourth refused; current attempt counts exactly once", () => {
  assert.equal(budget([run(1)], 1).decision, "allow")
  assert.equal(budget([run(1), run(2), run(3)], 3).decision, "allow")
  assert.equal(budget([run(1), run(2), run(3), run(4)], 4).decision, "limit_exhausted")
})

test("rerun, timeout, cancellation reserve attempts; budgets and PRs stay independent", () => {
  const attempts = [run(1, 1), run(1, 2), run(1, 3)]
  assert.equal(budget(attempts, 1, 3).decision, "allow")
  assert.equal(budget([...attempts, run(1, 4)], 1, 4).decision, "limit_exhausted")
  assert.equal(budget([run(1, 1, "review"), run(2, 1, "interactive", "pr-9"), run(3)], 3).count, 1)
  // Concurrent admissions reserve budget even if their models have not started.
  assert.equal(budget([run(1), run(2), run(3), run(4)], 1).decision, "limit_exhausted")
})

test("incomplete, duplicate or malformed history never authorizes the model", () => {
  for (const [runs, overrides] of [
    [[], {}], [[run(1)], { historyComplete: false }],
    [[run(1), run(1)], {}], [[{ ...run(1), run_attempt: "1" }], {}],
    [[{ ...run(1), admitted: undefined }], {}]
  ]) assert.equal(budget(runs, 1, 1, overrides).decision, "infra")
})

test("forks, default branches and unapproved bots are not trusted heads", () => {
  const pr = { state: "open", user: { login: "github-actions[bot]", type: "Bot" },
    base: { ref: "main", repo: { full_name: "owner/repo" } },
    head: { sha: "a".repeat(40), ref: "feat/task", repo: { full_name: "owner/repo" } } }
  assert.equal(trustedPullRequest(pr, "owner/repo", "owner"), true)
  assert.equal(trustedPullRequest({ ...pr, user: { login: "other[bot]", type: "Bot" } }, "owner/repo", "owner"), false)
  assert.equal(trustedPullRequest({ ...pr, head: { ...pr.head, repo: { full_name: "fork/repo" } } }, "owner/repo", "owner"), false)
})

test("approval is a genuine source-owner comment covering both specification and ticket list", () => {
  const context = { repo: "owner/repo", source: 17, spec: 22, tickets: [18, 19, 20, 21] }
  const approval = { id: 99, user: { login: "owner", type: "User" }, author_association: "OWNER",
    html_url: "https://github.com/owner/repo/issues/17#issuecomment-99",
    body: "Одобряю спецификацию #22 и актуальные тикеты #18–#21. Начинаем реализацию." }
  assert.equal(approvalValid(approval, context), true)
  assert.equal(approvalValid({ ...approval, body: "/oc одобряю спецификацию #22 и список тикетов #18–#21." }, context), true)
  assert.equal(approvalValid({ ...approval, user: { login: "github-actions[bot]", type: "Bot" } }, context), false)
  for (const body of ["Не одобряю спецификацию #22 и тикеты #18–#21", "ready-for-agent", "Одобряю спецификацию #22"]) {
    assert.equal(approvalValid({ ...approval, body }, context), false)
  }
  for (const body of [
    "Approve specification #22. Do not implement ticket #18; it is not approved.",
    "Одобряю спецификацию #22 и тикеты #18–#21. Но #18 не реализовывать.",
    "Одобряю спецификацию #22. Обсуждали тикеты #18–#21."
  ]) assert.equal(approvalValid({ ...approval, body }, { ...context, tickets: [18] }), false, body)
})

test("history collector counts each admitted run attempt across both comment event channels", async () => {
  const requested = []
  const api = { paginate: async (path, key) => {
    requested.push(path)
    if (key === "workflow_runs") return [
      { id: 10, run_attempt: 2, path: workflowPath, event: "issue_comment" },
      { id: 11, run_attempt: 1, path: workflowPath, event: "pull_request_review_comment" }
    ]
    return [{ name: "agent-admission:pr-8:interactive", conclusion: path.includes("/10/") ? "cancelled" : null }]
  } }
  const decision = await collectBudget({ api, repo: "owner/repo",
    current: { id: 11, run_attempt: 1 }, scope: "pr-8", mode: "interactive", workflowPath })
  assert.equal(decision.decision, "allow")
  assert.equal(decision.count, 3)
  assert.ok(requested.some((p) => p.includes("/10/attempts/1/jobs")))
  assert.ok(requested.some((p) => p.includes("/10/attempts/2/jobs")))
  assert.ok(requested.some((p) => p.includes("/11/attempts/1/jobs")))
  const failed = await collectBudget({ api: { paginate: async () => { throw new Error("API outage") } },
    repo: "owner/repo", current: { id: 11, run_attempt: 1 }, scope: "pr-8", mode: "interactive", workflowPath })
  assert.equal(failed.decision, "infra")
})

test("implementation and publisher share a protected policy/credentials path boundary", () => {
  for (const file of [".github/workflows/hexlet-check.yml", ".opencode/agents/x.md",
    "opencode.json", "frontend/opencode.jsonc", "AGENTS.md", "docs/AGENTS.md",
    "tooling/agent-policy.mjs", "backend/.env.production", "../outside", "/proc/self/environ",
    "mise.toml", "schema.png", "STEP-4.md"]) assert.equal(protectedPath(file), true, file)
  for (const file of ["frontend/src/views/Calendar.vue", "backend/app/models/booking.rb", "frontend/browser/calendar.spec.ts"]) {
    assert.equal(protectedPath(file), false, file)
  }
})

test("publication refuses a deleted/replaced artifact even if its run/name is reused", () => {
  const digest = "a".repeat(64)
  const artifact = { id: 70, name: "implementation-1", digest: `sha256:${digest}`, expired: false }
  const log = `2026-11-17T18:00:00Z agent-evidence:70:${digest}\n`
  assert.equal(verifiedArtifact([artifact], "implementation-1", log), artifact)
  assert.throws(() => verifiedArtifact([{ ...artifact, id: 71 }], "implementation-1", log))
  assert.throws(() => verifiedArtifact([{ ...artifact, digest: `sha256:${"b".repeat(64)}` }], "implementation-1", log))
  assert.throws(() => verifiedArtifact([artifact], "implementation-1", ""))
  assert.throws(() => verifiedArtifact([artifact], "implementation-1", log + log))
})
