#!/usr/bin/env node

const limit = 3
const [mode, rawPullRequest] = process.argv.slice(2)
const pullRequest = Number(rawPullRequest)

if (!["interactive", "review"].includes(mode) || !Number.isSafeInteger(pullRequest) || pullRequest < 1) {
  process.stderr.write("Usage: node tooling/agent-budget.mjs <interactive|review> <pull-request>\n")
  process.exit(2)
}

const runs = []
for await (const line of readLines()) {
  if (!line.trim()) continue
  try {
    runs.push(JSON.parse(line))
  } catch {
    process.stderr.write("Could not prove the agent budget from Actions history\n")
    process.exit(2)
  }
}

const escapedId = String(pullRequest)
const expectedName = new RegExp(`^agent-budget:pr-${escapedId}:${mode}$`)
const count = runs
  .filter((run) => expectedName.test(run.display_title ?? run.name ?? ""))
  .reduce((total, run) => total + Math.max(1, Number(run.run_attempt) || 1), 0)

process.stdout.write(JSON.stringify({
  decision: count >= limit ? "limit_exhausted" : "allow",
  count,
  limit,
  pull_request: pullRequest,
  budget: mode
}) + "\n")

async function* readLines() {
  let pending = ""
  for await (const chunk of process.stdin) {
    pending += chunk
    const lines = pending.split(/\r?\n/)
    pending = lines.pop()
    yield* lines
  }
  if (pending) yield pending
}
