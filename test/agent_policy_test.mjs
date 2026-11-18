import { test } from "node:test"
import assert from "node:assert/strict"
import { approvalValid, budgetDecision, collectBudget, github, protectedPath, routeCommand, trustedPullRequest, verifiedArtifact } from "../tooling/agent-policy.mjs"

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

test("review has five independent attempts while interactive remains limited to three", () => {
  const review = (id) => ({ ...run(id, 1, "review"), path: ".github/workflows/agent-review.yml" })
  const attempts = [review(1), review(2), review(3), review(4), review(5)]
  const decide = (runs, id) => budgetDecision({
    runs, current: { id, run_attempt: 1 }, mode: "review", scope: "pr-8",
    workflowPath: ".github/workflows/agent-review.yml", historyComplete: true
  })
  assert.equal(decide(attempts, 5).decision, "allow")
  assert.equal(decide(attempts, 5).limit, 5)
  assert.equal(decide([...attempts, review(6)], 6).decision, "limit_exhausted")
  assert.equal(budget([review(1), run(6), run(7), run(8)], 8).decision, "allow")
  assert.equal(budget([review(1), run(6), run(7), run(8), run(9)], 9).decision, "limit_exhausted")
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

const extension = () => ({
  repo: "owner/repo", scope: "issue-42", mode: "interactive", workflowPath,
  source: 8, spec: 9, ticket: 10, additional: 2,
  after: { id: 4, run_attempt: 1 },
  baseline: [1, 2, 3, 4].map((id) => ({ id, run_attempt: 1 })),
  approval: "https://github.com/owner/repo/issues/8#issuecomment-99"
})
const issueRun = (id, attempt = 1) => ({ ...run(id, attempt, "interactive", "issue-42"),
  startedAt: new Date(Date.UTC(2026, 0, 1) + ((attempt - 1) * 10 + id) * 1000).toISOString() })
const extendedBudget = (runs, id, attempt = 1, overrides = {}) =>
  budget(runs, id, attempt, { scope: "issue-42", extension: extension(), ...overrides })

test("an explicit extension allows only two new reservations without resetting the original history", () => {
  const baseline = [1, 2, 3, 4].map((id) => issueRun(id))
  assert.equal(extendedBudget([...baseline, issueRun(5)], 5).decision, "allow")
  const second = extendedBudget([...baseline, issueRun(5), issueRun(6)], 6)
  assert.equal(second.decision, "allow")
  assert.equal(second.count, 6)
  assert.equal(second.limit, 3)
  assert.equal(second.extension.count, 2)
  assert.equal(second.extension.limit, 2)
  assert.equal(extendedBudget([...baseline, issueRun(5), issueRun(6), issueRun(7)], 7).decision, "limit_exhausted")
  // The recorded refusal stays refused even when queried after the grant exists.
  assert.equal(extendedBudget(baseline, 4).decision, "limit_exhausted")
  assert.equal(budget([...baseline, issueRun(5)], 5, 1, { scope: "issue-42" }).decision, "limit_exhausted")
})

test("extensions charge old-run reruns and concurrent reservations and cannot expand PR budgets", () => {
  const baseline = [1, 2, 3, 4].map((id) => issueRun(id))
  const reruns = [...baseline, issueRun(1, 2), issueRun(1, 3)]
  assert.equal(extendedBudget(reruns, 1, 3).extension.count, 2)
  assert.equal(extendedBudget([...reruns, issueRun(1, 4)], 1, 4).decision, "limit_exhausted")
  // All admitted jobs reserve, including cancellation, timeout and queued competitors.
  assert.equal(extendedBudget([...baseline, issueRun(5), issueRun(6), issueRun(7)], 5).decision, "limit_exhausted")
  for (const grant of [
    { ...extension(), scope: "pr-8" }, { ...extension(), mode: "review" },
    { ...extension(), workflowPath: ".github/workflows/agent-review.yml" }
  ]) assert.equal(extendedBudget([...baseline, issueRun(5)], 5, 1, { extension: grant }).decision, "infra")
})

test("missing, altered, duplicate or unproven extension snapshots fail closed", () => {
  const runs = [1, 2, 3, 4, 5].map((id) => issueRun(id))
  for (const grant of [
    { ...extension(), additional: 0 }, { ...extension(), additional: "2" },
    { ...extension(), baseline: [...extension().baseline, { id: 4, run_attempt: 1 }] },
    { ...extension(), baseline: [{ id: 99, run_attempt: 1 }, ...extension().baseline.slice(1)] },
    { ...extension(), after: { id: 99, run_attempt: 1 } },
    { ...extension(), baseline: extension().baseline.slice(0, 3) }
  ]) assert.equal(extendedBudget(runs, 5, 1, { extension: grant }).decision, "infra")
  assert.equal(extendedBudget(runs.filter((r) => r.id !== 2), 5).decision, "infra")
  assert.equal(extendedBudget(runs, 5, 1, { historyComplete: false }).decision, "infra")
  assert.equal(extendedBudget(runs.map((r) => ({ ...r, startedAt: undefined })), 5).decision, "infra")
  assert.equal(extendedBudget(runs.map((r) => r.id === 5 ? { ...r, startedAt: issueRun(3).startedAt } : r), 5).decision, "infra")
})

test("collector requires genuine bounded owner approval from trusted grants, never a caller assertion", async () => {
  const grant = extension()
  const approval = {
    id: 99, user: { login: "owner", type: "User" }, author_association: "OWNER",
    html_url: grant.approval,
    body: "Одобряю дополнение спецификации #9 и тикета #10: 2 дополнительные интерактивные попытки для issue-42 после запуска 4, без сброса истории и изменения PR-бюджетов."
  }
  const collect = async (comments = approval, grants = [grant]) => {
    const api = Object.assign(async (path) => {
      assert.equal(path, "repos/owner/repo/issues/comments/99")
      return comments
    }, { paginate: async (path, key) => key === "workflow_runs"
      ? [1, 2, 3, 4, 5].map((id) => ({ id, run_attempt: 1, path: workflowPath }))
      : [{ name: "agent-admission:issue-42:interactive", conclusion: path.includes("/5/") ? null : "cancelled",
        started_at: issueRun(Number(/\/runs\/(\d+)\//u.exec(path)?.[1])).startedAt }] })
    return collectBudget({ api, repo: "owner/repo", current: { id: 5, run_attempt: 1 },
      scope: "issue-42", mode: "interactive", workflowPath, grants })
  }
  assert.equal((await collect()).decision, "allow")
  for (const comment of [
    null, { ...approval, user: { login: "other", type: "User" } },
    { ...approval, user: { login: "owner", type: "Bot" } },
    { ...approval, author_association: "MEMBER" },
    { ...approval, html_url: grant.approval.replace("issues/8", "issues/7") },
    { ...approval, body: approval.body.replace("2 дополнительные", "3 дополнительные") },
    { ...approval, body: `${approval.body} Но только после нового решения.` }
  ]) assert.equal((await collect(comment)).decision, "infra")
  assert.equal((await collect(approval, [grant, grant])).decision, "infra")
  assert.equal((await collect(approval, [])).decision, "limit_exhausted")
  assert.equal((await collect(approval, [{ ...grant, scope: "issue-99" }])).decision, "limit_exhausted")
})

test("issue grants leave other issue and both PR budgets unchanged", async () => {
  for (const [scope, mode, path] of [
    ["issue-99", "interactive", workflowPath], ["pr-8", "interactive", workflowPath],
    ["pr-8", "review", ".github/workflows/agent-review.yml"]
  ]) {
    const limit = mode === "review" ? 5 : 3
    for (const count of [limit, limit + 1]) {
      const api = Object.assign(async () => { throw new Error("Unrelated grant must not fetch approval") },
        { paginate: async (_path, key) => key === "workflow_runs"
          ? Array.from({ length: count }, (_, index) => ({ id: index + 1, run_attempt: 1, path }))
          : [{ name: `agent-admission:${scope}:${mode}`, conclusion: null }] })
      const decision = await collectBudget({ api, repo: "owner/repo", scope, mode, workflowPath: path,
        current: { id: count, run_attempt: 1 }, grants: [extension()] })
      assert.equal(decision.decision, count === limit ? "allow" : "limit_exhausted")
      assert.equal(decision.count, count)
      assert.equal(decision.extension, undefined)
    }
  }
})

test("extension proof traverses all Actions and job pages and rejects incomplete pagination", async () => {
  const originalFetch = globalThis.fetch
  const grant = extension()
  let omitLastPage = false
  const requested = []
  globalThis.fetch = async (url) => {
    const path = new URL(url).pathname
    const page = Number(new URL(url).searchParams.get("page") ?? 1)
    requested.push(`${path}:${page}`)
    let body
    if (path.endsWith("/issues/comments/99")) {
      body = { id: 99, user: { login: "owner", type: "User" }, author_association: "OWNER",
        html_url: grant.approval,
        body: "Одобряю дополнение спецификации #9 и тикета #10: 2 дополнительные интерактивные попытки для issue-42 после запуска 4, без сброса истории и изменения PR-бюджетов." }
    } else if (path.endsWith("/runs")) {
      const all = Array.from({ length: 105 }, (_, index) => ({ id: index + 1, run_attempt: 1, path: workflowPath }))
      body = { total_count: 105, workflow_runs: omitLastPage && page === 2 ? [] : all.slice((page - 1) * 100, page * 100) }
    } else {
      const id = Number(/\/runs\/(\d+)\//u.exec(path)?.[1])
      const admission = { name: "agent-admission:issue-42:interactive", conclusion: id === 5 ? null : "timed_out",
        started_at: issueRun(id).startedAt }
      const jobs = id === 1
        ? [...Array.from({ length: 100 }, () => ({ name: "unrelated", conclusion: "success" })), admission]
        : id <= 5 ? [admission] : []
      body = { total_count: jobs.length, jobs: jobs.slice((page - 1) * 100, page * 100) }
    }
    return new Response(JSON.stringify(body), { status: 200 })
  }
  try {
    const request = { api: github, repo: "owner/repo", current: { id: 5, run_attempt: 1 },
      scope: "issue-42", mode: "interactive", workflowPath, grants: [grant] }
    const allowed = await collectBudget(request)
    assert.equal(allowed.decision, "allow")
    assert.equal(allowed.extension.count, 1)
    assert.ok(requested.some((path) => path.endsWith("/implement-spec.yml/runs:2")))
    assert.ok(requested.some((path) => path.endsWith("/runs/1/attempts/1/jobs:2")))
    omitLastPage = true
    assert.equal((await collectBudget(request)).decision, "infra")
  } finally { globalThis.fetch = originalFetch }
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
    "tooling/agent-policy.mjs", "tooling/agent-budget-grants.json", "backend/.env.production", "../outside", "/proc/self/environ",
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
