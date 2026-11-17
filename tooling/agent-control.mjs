import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { execFileSync } from "node:child_process"
import { routeCommand, trustedPullRequest, approvalValid, collectBudget, protectedPath, github } from "./agent-policy.mjs"

const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"))
const repo = process.env.GITHUB_REPOSITORY
const directory = process.env.AGENT_OUTPUT ?? `${process.env.RUNNER_TEMP}/implementation`
const output = (key, value) => {
  if (/[\r\n]/.test(String(value))) throw new Error("Invalid output")
  appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`)
}
const save = (name, data) => writeFileSync(`${directory}/${name}`, JSON.stringify(data, null, 2))
const current = { id: Number(process.env.GITHUB_RUN_ID), run_attempt: Number(process.env.GITHUB_RUN_ATTEMPT) }
const number = event.issue?.number ?? event.pull_request?.number
const api = (path) => github(`repos/${repo}/${path}`)
const all = (path, key) => github.paginate(`repos/${repo}/${path}`, key)
const git = (cwd, ...args) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd, encoding: "utf8" }).trim()
mkdirSync(directory, { recursive: true })

try {
  if (process.argv[2] === "route") {
    const request = routeCommand(event)
    output("run", request.mode !== "discussion")
    output("scope", `${request.mode === "fix" ? "pr" : "issue"}-${number}`)
  } else if (process.argv[2] === "prepare") {
    const request = routeCommand(event)
    if (request.mode === "discussion") throw new Error("No explicit implementation authority")
    let context, pr
    if (request.mode === "fix") {
      pr = await api(`pulls/${number}`)
      if (!trustedPullRequest(pr, repo, repo.split("/")[0])) throw new Error("Untrusted PR head")
      const match = (pr.body ?? "").match(/<!-- agent-context (\{[^\n]*\}) -->/)
      if (!match) throw new Error("Missing source/spec/ticket/approval provenance in PR")
      context = JSON.parse(match[1])
    } else {
      context = { source: number, spec: request.spec, tickets: request.tickets, approval: request.approval }
    }
    if (![context.source, context.spec, ...context.tickets].every((n) => Number.isSafeInteger(n) && n > 0) ||
        context.tickets.length === 0 || context.tickets.length > 100) throw new Error("Invalid task graph")
    const approvalURL = new RegExp(`^https://github\\.com/${repo}/issues/${context.source}#issuecomment-([1-9]\\d*)$`).exec(context.approval)
    if (!approvalURL) throw new Error("Invalid approval permalink")
    const approval = await api(`issues/comments/${approvalURL[1]}`)
    if (!approvalValid(approval, { ...context, repo })) throw new Error("No genuine source-owner approval")
    const source = await api(`issues/${context.source}`)
    const spec = await api(`issues/${context.spec}`)
    if (source.pull_request || spec.pull_request) throw new Error("Source and specification must be issues")
    const tickets = []
    for (const n of context.tickets) {
      const ticket = await api(`issues/${n}`)
      if (ticket.pull_request || !new RegExp(`#${context.spec}(?!\\d)`).test(ticket.body ?? "")) throw new Error("Ticket does not reference requested spec")
      const blockers = await all(`issues/${n}/dependencies/blocked_by`)
      const section = ticket.body?.match(/## Blocked by\s+([\s\S]*?)(?=\n## |$)/i)?.[1] ?? ""
      const textual = [...section.matchAll(/#([1-9]\d*)/g)].map((m) => Number(m[1]))
      // Explanatory text following an explicit None is not a dependency list.
      const dependencies = /^None\b/i.test(section.trim()) ? blockers : [
        ...blockers, ...await Promise.all(textual.map((id) => api(`issues/${id}`)))
      ]
      if (dependencies.some((item) => item.state !== "closed" && !context.tickets.includes(item.number))) {
        throw new Error("Open external blocker")
      }
      tickets.push({ ...ticket, comments: await all(`issues/${n}/comments`),
        blockers: dependencies.filter((item) => item.state !== "closed").map((item) => item.number) })
    }
    const pending = new Set(tickets.filter((t) => t.state !== "closed").map((t) => t.number))
    const order = []
    while (pending.size) {
      const frontier = tickets.filter((t) => pending.has(t.number) && !t.blockers.some((n) => pending.has(n)))
      if (!frontier.length) throw new Error("Cyclic or unstartable task graph")
      for (const ticket of frontier) { pending.delete(ticket.number); order.push(ticket.number) }
    }
    const branch = pr?.head.ref ?? `feat/spec-${context.spec}`
    const base = await api(`branches/${encodeURIComponent(event.repository.default_branch)}`)
    const sha = pr?.head.sha ?? base.commit.sha
    if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("Invalid SHA")
    const metadata = { ...context, repo, mode: request.mode, pr: pr?.number ?? null, branch, sha,
      base: event.repository.default_branch, order, run: current.id, attempt: current.run_attempt }
    save("metadata.json", metadata)
    output("sha", sha)
    const budget = await collectBudget({ repo, current, mode: "interactive",
      scope: `${pr ? "pr" : "issue"}-${number}`, workflowPath: ".github/workflows/implement-spec.yml" })
    save("budget.json", budget)
    output("decision", budget.decision)
    if (budget.decision !== "allow") process.exit(0)
    save("context.json", {
      metadata, trigger: event.comment, source,
      discussion: await all(`issues/${context.source}/comments`),
      spec: { ...spec, comments: await all(`issues/${context.spec}/comments`) }, tickets,
      approval, pr, prDiscussion: pr ? await all(`issues/${number}/comments`) : [],
      reviews: pr ? await all(`pulls/${number}/reviews`) : [],
      inline: pr ? await all(`pulls/${number}/comments`) : []
    })
  } else if (process.argv[2] === "patch") {
    const candidate = resolve(process.argv[3])
    const paths = git(candidate, "diff", "--name-only", "-z", "--no-renames", "HEAD").split("\0").filter(Boolean)
    const untracked = git(candidate, "ls-files", "-z", "--others", "--exclude-standard").split("\0").filter(Boolean)
    for (const path of [...paths, ...untracked]) {
      if (protectedPath(path)) throw new Error(`Protected policy/runtime path: ${path}`)
    }
    git(candidate, "add", "--intent-to-add", "--all")
    writeFileSync(`${directory}/implementation.patch`, execFileSync("git",
      ["-c", "core.hooksPath=/dev/null", "diff", "--binary", "--no-ext-diff", "HEAD"], { cwd: candidate }))
    git(candidate, "diff", "--check")
  } else throw new Error("Unknown agent-control operation")
} catch (error) {
  // Only trusted error messages, no response bodies or credentials.
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
}
