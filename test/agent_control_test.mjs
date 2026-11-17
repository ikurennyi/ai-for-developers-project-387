// External GitHub boundary fixtures; run the real trusted adapter and policy.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"

function fixture(event, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), "agent-control-test-"))
  const base = "https://api.github.com/repos/owner/repo/"
  const pages = (name) => `${base}${name}?per_page=100&page=1`
  const approval = {
    id: 99, author_association: "OWNER", user: { login: "owner", type: "User" },
    html_url: "https://github.com/owner/repo/issues/8#issuecomment-99",
    body: "Approve specification #42 and tickets #43."
  }
  const routes = {
    [`${base}issues/comments/99`]: approval,
    [`${base}issues/8`]: { number: 8, body: "Source" },
    [`${base}issues/42`]: { number: 42, body: "Source #8", state: "open" },
    [`${base}issues/43`]: { number: 43, body: "Spec #42\n## Blocked by\nNone", state: "open" },
    [pages("issues/43/dependencies/blocked_by")]: [],
    [pages("issues/43/comments")]: [{ id: 2, body: "Ticket discussion" }],
    [pages("issues/42/comments")]: [{ id: 3, body: "Spec discussion" }],
    [pages("issues/8/comments")]: [approval],
    [`${base}branches/main`]: { commit: { sha: "a".repeat(40) } },
    [pages("actions/workflows/implement-spec.yml/runs")]: {
      total_count: 1, workflow_runs: [{ id: 100, run_attempt: 1, path: ".github/workflows/implement-spec.yml" }]
    },
    [pages("actions/runs/100/attempts/1/jobs")]: {
      total_count: 1, jobs: [{ name: `agent-admission:${event.issue?.pull_request || event.pull_request ? "pr" : "issue"}-${event.issue?.number ?? event.pull_request.number}:interactive`, conclusion: null }]
    },
    ...overrides
  }
  writeFileSync(join(directory, "routes.json"), JSON.stringify(routes))
  writeFileSync(join(directory, "event.json"), JSON.stringify(event))
  writeFileSync(join(directory, "output"), "")
  writeFileSync(join(directory, "fetch.mjs"), `
    import fs from "node:fs";
    const routes = JSON.parse(fs.readFileSync(process.env.FIXTURE_ROUTES));
    globalThis.fetch = async (url) => {
      if (!Object.hasOwn(routes, String(url))) return new Response("{}", {status:404});
      return new Response(JSON.stringify(routes[String(url)]), {status:200,headers:{"Content-Type":"application/json"}});
    };
  `)
  return {
    directory,
    run() {
      return spawnSync(process.execPath, ["--import", join(directory, "fetch.mjs"), resolve("tooling/agent-control.mjs"), "prepare"], {
        encoding: "utf8",
        env: { ...process.env, GH_TOKEN: "fixture-only", GITHUB_REPOSITORY: "owner/repo",
          GITHUB_EVENT_PATH: join(directory, "event.json"), GITHUB_OUTPUT: join(directory, "output"),
          GITHUB_RUN_ID: "100", GITHUB_RUN_ATTEMPT: "1", FIXTURE_ROUTES: join(directory, "routes.json"),
          AGENT_OUTPUT: join(directory, "evidence") }
      })
    },
    cleanup() { rmSync(directory, { recursive: true, force: true }) }
  }
}
const sourceEvent = () => ({
  action: "created", repository: { default_branch: "main" }, issue: { number: 8 },
  comment: { body: "/oc implement-spec #42 tickets #43 approval https://github.com/owner/repo/issues/8#issuecomment-99",
    user: { type: "User" }, author_association: "OWNER" }
})

test("real executor validates source approval, task graph and budget before producing runtime context", () => {
  const f = fixture(sourceEvent())
  try {
    const result = f.run()
    assert.equal(result.status, 0, result.stderr)
    const metadata = JSON.parse(readFileSync(join(f.directory, "evidence/metadata.json")))
    assert.equal(metadata.branch, "feat/spec-42")
    assert.deepEqual(metadata.order, [43])
    const context = JSON.parse(readFileSync(join(f.directory, "evidence/context.json")))
    assert.equal(context.spec.comments[0].body, "Spec discussion")
    assert.equal(context.tickets[0].comments[0].body, "Ticket discussion")
    assert.match(readFileSync(join(f.directory, "output"), "utf8"), /decision=allow/)
  } finally { f.cleanup() }
})

test("explicitly excluded work and open external blockers never reach model context", () => {
  const base = "https://api.github.com/repos/owner/repo/"
  for (const overrides of [
    { [`${base}issues/comments/99`]: {
      id: 99, author_association: "OWNER", user: { login: "owner", type: "User" },
      html_url: "https://github.com/owner/repo/issues/8#issuecomment-99",
      body: "Approve specification #42. Do not implement ticket #43."
    } },
    { [`${base}issues/43/dependencies/blocked_by?per_page=100&page=1`]: [{ number: 44, state: "open" }] }
  ]) {
    const f = fixture(sourceEvent(), overrides)
    try {
      assert.notEqual(f.run().status, 0)
      assert.equal(existsSync(join(f.directory, "evidence/context.json")), false)
    } finally { f.cleanup() }
  }
})

test("exhaustion reports the actual candidate SHA without producing model input", () => {
  const base = "https://api.github.com/repos/owner/repo/"
  const overrides = {}
  overrides[`${base}actions/workflows/implement-spec.yml/runs?per_page=100&page=1`] = {
    total_count: 1, workflow_runs: [{ id: 100, run_attempt: 4, path: ".github/workflows/implement-spec.yml" }]
  }
  for (let attempt = 2; attempt <= 4; attempt += 1) {
    overrides[`${base}actions/runs/100/attempts/${attempt}/jobs?per_page=100&page=1`] = {
      total_count: 1, jobs: [{ name: "agent-admission:issue-8:interactive", conclusion: "cancelled" }]
    }
  }
  const f = fixture(sourceEvent(), overrides)
  try {
    // Current attempt 1 still reserves alongside all concurrent/rerun admissions;
    // no model may start when the shared history proves four reservations.
    assert.equal(f.run().status, 0)
    assert.equal(existsSync(join(f.directory, "evidence/context.json")), false)
    const outputs = readFileSync(join(f.directory, "output"), "utf8")
    assert.match(outputs, /decision=limit_exhausted/)
    assert.match(outputs, new RegExp(`sha=${"a".repeat(40)}`))
  } finally { f.cleanup() }
})

test("ordinary and inline fixes use the same PR scope and receive complete position context", () => {
  const base = "https://api.github.com/repos/owner/repo/"
  const metadata = { source: 8, spec: 42, tickets: [43],
    approval: "https://github.com/owner/repo/issues/8#issuecomment-99" }
  for (const inline of [false, true]) {
    const event = sourceEvent()
    if (inline) { delete event.issue; event.pull_request = { number: 19 } }
    else event.issue = { number: 19, pull_request: {} }
    event.comment = { ...event.comment, body: "/oc fix\nCorrect the behavior",
      path: "frontend/src/views/Calendar.vue", line: 12, original_line: 10, side: "RIGHT", diff_hunk: "@@ -10 +12 @@" }
    const f = fixture(event, {
      [`${base}pulls/19`]: {
        number: 19, state: "open", user: { login: "owner", type: "User" },
        base: { ref: "main", repo: { full_name: "owner/repo" } },
        head: { sha: "b".repeat(40), ref: "feat/spec-42", repo: { full_name: "owner/repo" } },
        body: `<!-- agent-context ${JSON.stringify(metadata)} -->`
      },
      [`${base}issues/19/comments?per_page=100&page=1`]: [{ body: "Full PR discussion" }],
      [`${base}pulls/19/reviews?per_page=100&page=1`]: [{ body: "Earlier review" }],
      [`${base}pulls/19/comments?per_page=100&page=1`]: [event.comment]
    })
    try {
      const result = f.run()
      assert.equal(result.status, 0, result.stderr)
      const context = JSON.parse(readFileSync(join(f.directory, "evidence/context.json")))
      assert.equal(context.metadata.pr, 19)
      assert.equal(context.metadata.sha, "b".repeat(40))
      assert.equal(context.prDiscussion[0].body, "Full PR discussion")
      for (const key of ["path", "line", "original_line", "side", "diff_hunk"]) {
        assert.equal(context.trigger[key], event.comment[key])
        assert.equal(context.inline[0][key], event.comment[key])
      }
    } finally { f.cleanup() }
  }
})
