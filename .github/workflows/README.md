# Automatic tests

After completing all the steps in the project, automatic tests will become available to you. Tests are run on each commit - once all tasks in the Hexlet interface are completed, make a commit, and the tests will run automatically.

The hexlet-check.yml file is responsible for running these tests - do not delete this file, edit it, or rename the repository.

## Project checks and agent workflows

- `application-check.yml`: ordinary test/lint/contract/build and policy gates.
- `issue-triage.yml` / `opencode.yml`: isolated triage and discussion/publication.
- `implement-spec.yml`: explicit approved implementation or human PR fix;
  isolated model, shared finite budget, independent checks and final reporter.
- `agent-publish.yml`: owner-dispatched push and optional draft PR, separately
  authorized; no model, merge or automatic workflow-dispatch cascade.
- `agent-review.yml`: independent read-only PR review, including approved
  automation identity, exact SHA, five-attempt review budget, bounded linked
  context and stale cancellation.
- `browser-evidence.yml`: isolated exact-head application/browser check without
  model secret; uploads traces, results, actual SHA and diagnostic screenshots.
- `release-please.yml`: unchanged release automation and separate release token.

Setup, trust boundaries, command grammar and remaining human gates:
[executor](../../docs/agent-executor.md),
[review](../../docs/agent-review.md),
[browser evidence](../../docs/browser-evidence.md).

GITHUB_TOKEN-created updates may need owner confirmation/re-run. Every new head
requires fresh CI, review and browser evidence. Never accept an old green run
whose recorded SHA differs from the PR head. No workflow merges PRs.
