// Runs only in an owner-dispatched job without a model or candidate-code execution.
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import { github, trustedPullRequest, approvalValid } from "./agent-policy.mjs"

const repo = process.env.GITHUB_REPOSITORY
const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"))
const inputs = event.inputs
const runId = Number(inputs.run_id)
const expected = inputs.expected_sha
const api = (path, options) => github(`repos/${repo}/${path}`, options)
const directory = mkdtempSync(join(tmpdir(), "agent-publication-"))
const git = (...args) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: directory, encoding: "utf8" }).trim()

try {
  const repository = await api("")
  if (event.sender?.login !== repository.owner.login || inputs.allow_push !== "true" ||
      !Number.isSafeInteger(runId) || !/^[a-f0-9]{40}$/.test(expected ?? "")) throw new Error("Owner publication permission missing")
  const run = await api(`actions/runs/${runId}`)
  if (run.repository.full_name !== repo || run.path !== ".github/workflows/implement-spec.yml" ||
      !["issue_comment", "pull_request_review_comment"].includes(run.event) ||
      run.status !== "completed" || run.conclusion !== "success") throw new Error("Implementation/check run is not successful")
  // Download a single immutable Actions artifact from the exact successful attempt.
  const artifacts = (await github.paginate(`repos/${repo}/actions/runs/${runId}/artifacts`, "artifacts"))
    .filter((item) => item.name === `implementation-${run.run_attempt}` && !item.expired)
  if (artifacts.length !== 1) throw new Error("Missing/ambiguous implementation artifact")
  const archive = join(directory, "evidence.zip")
  execFileSync("gh", ["api", `repos/${repo}/actions/artifacts/${artifacts[0].id}/zip`], {
    stdio: ["ignore", (await import("node:fs")).openSync(archive, "w"), "inherit"]
  })
  // Extract only the two named data files. Never execute or trust artifact scripts.
  const metadata = JSON.parse(execFileSync("unzip", ["-p", archive, "metadata.json"], { encoding: "utf8" }))
  const patch = execFileSync("unzip", ["-p", archive, "implementation.patch"])
  if (metadata.repo !== repo || metadata.sha !== expected || metadata.run !== runId ||
      metadata.attempt !== run.run_attempt || !/^[a-z]+\/[a-z0-9][a-z0-9/-]*$/.test(metadata.branch)) {
    throw new Error("Artifact provenance or expected SHA differs")
  }
  const approvalId = metadata.approval?.match(/#issuecomment-([1-9]\d*)$/)?.[1]
  if (!approvalId || !approvalValid(await api(`issues/comments/${approvalId}`), { ...metadata, repo })) throw new Error("Approval revoked")
  let pr
  if (metadata.pr) {
    pr = await api(`pulls/${metadata.pr}`)
    if (!trustedPullRequest(pr, repo, repository.owner.login) || pr.head.sha !== expected || pr.head.ref !== metadata.branch) {
      throw new Error("PR head changed; rerun implementation and checks")
    }
  } else {
    const existing = await github.paginate(`repos/${repo}/pulls?state=all&head=${encodeURIComponent(`${repository.owner.login}:${metadata.branch}`)}`)
    if (existing.length) throw new Error("Existing PR for integration branch; use PR fix mode")
    const base = await api(`branches/${encodeURIComponent(metadata.base)}`)
    if (base.commit.sha !== expected) throw new Error("Base advanced; rebuild and recheck candidate")
  }
  git("init")
  git("remote", "add", "origin", `https://github.com/${repo}.git`)
  git("fetch", "--no-tags", "origin", expected)
  git("checkout", "-b", metadata.branch, "FETCH_HEAD")
  const patchFile = join(directory, "candidate.patch")
  writeFileSync(patchFile, patch)
  git("apply", "--check", "--index", patchFile)
  git("apply", "--index", patchFile)
  const changes = git("diff", "--cached", "--name-only", "--no-renames").split("\n")
  if (!changes.length || changes.some((path) => path.startsWith(".") ||
      /(^|\/)(AGENTS\.md|CLAUDE\.md|opencode\.jsonc?|mise(?:\.local)?\.toml)$/.test(path) ||
      path.startsWith("tooling/agent-") || /(^|\/)[^/]*\.env/.test(path))) {
    throw new Error("Patch contains protected policy or credential paths")
  }
  git("diff", "--cached", "--check")
  git("config", "user.name", "github-actions[bot]")
  git("config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com")
  const subject = `${pr ? "fix" : "feat"}: implement approved specification (#${metadata.tickets[0]})`
  git("commit", "-m", subject)
  const sha = git("rev-parse", "HEAD")
  // No force push. The explicit lease also refuses creation over an existing branch.
  const lease = `${metadata.branch}:${pr ? expected : ""}`
  const auth = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${process.env.GH_TOKEN}`).toString("base64")}`
  // Pass authorization through environment, never argv or persisted Git config.
  execFileSync("git", ["-c", "core.hooksPath=/dev/null", "push", `--force-with-lease=refs/heads/${lease}`,
    "origin", `HEAD:refs/heads/${metadata.branch}`], {
    cwd: directory, stdio: "pipe",
    env: { ...process.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader", GIT_CONFIG_VALUE_0: auth }
  })
  const url = `${process.env.GITHUB_SERVER_URL}/${repo}/actions/runs/${runId}`
  const body = `Source: #${metadata.source}\nSpec: #${metadata.spec}\nTickets: ${metadata.tickets.map((n) => `#${n}`).join(", ")}\nApproval: ${metadata.approval}\n\n` +
    `## Checks\nmise run ci:validate; mise run check. Candidate base SHA: ${expected}. Evidence: ${url}. Published SHA: ${sha}.\n` +
    `Fresh checks and independent review of ${sha} require owner confirmation before merge.\n\n` +
    `## Risk\n${metadata.mode === "fix" ? "PR feedback corrections may regress adjacent behavior." : "Approved product behavior and its adjacent flows may regress."} Review the patch, test evidence and browser artifact.\n\n` +
    `## Rollback\nRevert the implementation commit in Git, then repeat aggregate and browser checks. If the diff contains migrations/data changes, assess data recovery separately; code revert alone is not proof of recovery.\n\n` +
    metadata.tickets.map((n) => `Closes #${n}`).join("\n") +
    `\n\n<!-- agent-context ${JSON.stringify({ source: metadata.source, spec: metadata.spec, tickets: metadata.tickets, approval: metadata.approval })} -->`
  if (!pr && inputs.allow_pr === "true") {
    const created = await api("pulls", { method: "POST", body: JSON.stringify({
      title: subject, head: metadata.branch, base: metadata.base, body, draft: true
    }) })
    process.stdout.write(`${created.html_url}\n`)
  } else {
    process.stdout.write(`Pushed ${sha} to ${metadata.branch}; PR creation ${pr ? "not needed" : "not authorized"}.\n`)
  }
} catch {
  // Never print spawn errors containing authorization or candidate text.
  process.stderr.write("Publication refused or failed; inspect validated inputs, provenance and head state. No automatic retry.\n")
  process.exitCode = 1
}
