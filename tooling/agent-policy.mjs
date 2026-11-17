// Shared trust, routing and finite-budget boundary for implementer and reviewer.
export function routeCommand(event) {
  const comment = event.comment
  if (event.action !== "created" || !comment || comment.user?.type !== "User" ||
      !["OWNER", "MEMBER", "COLLABORATOR"].includes(comment.author_association)) return { mode: "discussion" }
  const body = comment.body.trim()
  const isPR = Boolean(event.pull_request || event.issue?.pull_request)
  if (isPR) {
    const fix = body.match(/^\/(?:oc|opencode) fix(?:\n([\s\S]+))?$/u)
    return fix ? { mode: "fix", request: fix[1] ?? "" } : { mode: "discussion" }
  }
  const match = body.match(/^\/(?:oc|opencode) implement-spec #([1-9]\d*) tickets (#(?:[1-9]\d*)(?:,#[1-9]\d*)*) approval (https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/issues\/[1-9]\d*#issuecomment-[1-9]\d*)$/u)
  if (!match) return { mode: "discussion" }
  const tickets = match[2].split(",").map((item) => Number(item.slice(1)))
  if (new Set(tickets).size !== tickets.length) return { mode: "discussion" }
  return { mode: "implement", spec: Number(match[1]), tickets, approval: match[3] }
}

export function trustedPullRequest(pr, repo, owner) {
  return Boolean(pr && pr.state === "open" && pr.base?.repo?.full_name === repo &&
    pr.head?.repo?.full_name === repo && /^[a-f0-9]{40}$/.test(pr.head?.sha ?? "") &&
    /^[a-z]+\/[a-z0-9][a-z0-9/-]*$/.test(pr.head?.ref ?? "") &&
    pr.head.ref !== pr.base.ref &&
    (pr.user?.login === owner || pr.user?.login === "github-actions[bot]" ||
      (pr.user?.type === "User" && ["OWNER", "MEMBER", "COLLABORATOR"].includes(pr.author_association))))
}

export function approvalValid(comment, { repo, source, spec, tickets }) {
  if (comment?.user?.login !== repo.split("/")[0] || comment.user.type !== "User" ||
      comment.author_association !== "OWNER" ||
      comment.html_url !== `https://github.com/${repo}/issues/${source}#issuecomment-${comment.id}`) return false
  const body = (comment.body ?? "").trim().replace(/^\/(?:oc|opencode)[ \t]+/u, "")
  // An explicit bounded approval clause, not arbitrary issue mentions later in
  // the comment. Unsupported prose/qualifications require human clarification.
  const clause = new RegExp(`^(?:Одобряю спецификацию #${spec} и (?:актуальные тикеты|список тикетов(?: из единственного тикета)?|тикеты)|Approve specification #${spec} and tickets) ((?:#[1-9]\\d*(?:[–-]#[1-9]\\d*)?)(?:,\\s*#[1-9]\\d*(?:[–-]#[1-9]\\d*)?)*)(?:\\.(?: (?:Начинаем реализацию|Можно реализовывать|Implementation approved)\\.)?)?$`, "iu").exec(body)
  if (!clause) return false
  const list = clause[1]
  const approved = new Set([...list.matchAll(/#([1-9]\d*)/g)].map((match) => Number(match[1])))
  for (const range of list.matchAll(/#([1-9]\d*)[–-]#([1-9]\d*)/g)) {
    const start = Number(range[1]), end = Number(range[2])
    if (end - start > 100 || end < start) return false
    for (let n = start; n <= end; n += 1) approved.add(n)
  }
  return tickets.every((ticket) => approved.has(ticket))
}

export function protectedPath(path) {
  return typeof path !== "string" || !path || path.startsWith(".") ||
    path.startsWith("/") || path.split("/").includes("..") ||
    /(^|\/)(?:AGENTS\.md|CLAUDE\.md|opencode\.jsonc?|mise(?:\.local)?\.toml)$/.test(path) ||
    /(^|\/)[^/]*\.env(?:\.|$)/.test(path) || path.startsWith("tooling/agent-") ||
    path === "STEP-4.md" || path === "schema.png"
}

// Bind publication to the trusted producer's append-only Actions log, not just
// an artifact name another job in the run could delete and reuse.
export function verifiedArtifact(artifacts, name, producerLog) {
  const markers = [...producerLog.matchAll(/\bagent-evidence:([1-9]\d*):([a-f0-9]{64})\b/g)]
  if (markers.length !== 1) throw new Error("Unproven artifact producer")
  const [, id, digest] = markers[0]
  const matching = artifacts.filter((item) => String(item.id) === id && item.name === name &&
    !item.expired && item.digest === `sha256:${digest}`)
  if (matching.length !== 1) throw new Error("Artifact differs from trusted producer evidence")
  return matching[0]
}

export function budgetDecision({ runs, current, mode, scope, workflowPath, historyComplete }) {
  const deny = { decision: "infra", reason: "budget_not_proven" }
  if (!historyComplete || !Array.isArray(runs) || !["interactive", "review"].includes(mode) ||
      !/^(?:pr|issue)-[1-9]\d*$/.test(scope ?? "") ||
      !Number.isSafeInteger(current?.id) || current.id < 1 ||
      !Number.isSafeInteger(current?.run_attempt) || current.run_attempt < 1) return deny
  const ids = new Set()
  let count = 0
  let found = false
  for (const run of runs) {
    if (!Number.isSafeInteger(run.id) || !Number.isSafeInteger(run.run_attempt) ||
        run.id < 1 || run.run_attempt < 1 || typeof run.admitted !== "boolean") return deny
    const key = `${run.id}:${run.run_attempt}`
    if (ids.has(key)) return deny
    ids.add(key)
    if (run.path !== workflowPath || run.scope !== scope || run.mode !== mode) continue
    if (run.id === current.id && run.run_attempt === current.run_attempt && run.admitted) found = true
    if (run.admitted) count += 1
  }
  if (!found) return deny
  return { decision: count > 3 ? "limit_exhausted" : "allow", count, limit: 3, scope, mode }
}

export async function github(path, options = {}) {
  if (!path.startsWith("repos/") || path.includes("..")) throw new Error("Invalid GitHub API path")
  const response = await fetch(`https://api.github.com/${path}`, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${process.env.GH_TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers
    },
    signal: AbortSignal.timeout(30000)
  })
  if (!response.ok) throw new Error(`GitHub API ${response.status}: ${path.split("?")[0]}`)
  if (response.status === 204) return null
  return response.json()
}

github.paginate = async (path, key) => {
  const result = []
  let expected
  for (let page = 1; ; page += 1) {
    if (page > 1000) throw new Error("Unprovable pagination")
    const body = await github(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`)
    const items = key ? body[key] : body
    if (!Array.isArray(items)) throw new Error("Invalid paginated response")
    if (page === 1) expected = body.total_count
    result.push(...items)
    if (items.length < 100) break
  }
  if (expected !== undefined && expected !== result.length) throw new Error("Actions history changed or is incomplete")
  return result
}

export async function collectBudget({ api = github, repo, current, mode, scope, workflowPath }) {
  try {
    const workflows = await api.paginate(`repos/${repo}/actions/workflows/${encodeURIComponent(workflowPath.split("/").at(-1))}/runs`, "workflow_runs")
    const records = []
    for (const run of workflows) {
      if (!Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1) throw new Error("Missing run attempt")
      for (let attempt = 1; attempt <= run.run_attempt; attempt += 1) {
        const jobs = await api.paginate(`repos/${repo}/actions/runs/${run.id}/attempts/${attempt}/jobs`, "jobs")
        const admission = jobs.filter((job) => job.name === `agent-admission:${scope}:${mode}`)
        if (admission.length > 1) throw new Error("Ambiguous admission")
        records.push({
          id: run.id, run_attempt: attempt, path: run.path,
          mode, scope, admitted: admission.length === 1 && admission[0].conclusion !== "skipped"
        })
      }
    }
    return budgetDecision({ runs: records, current, mode, scope, workflowPath, historyComplete: true })
  } catch {
    return { decision: "infra", reason: "budget_not_proven" }
  }
}
