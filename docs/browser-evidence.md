# Exact PR-head browser evidence (#20)

`.github/workflows/browser-evidence.yml` is a separate `pull_request` check,
independent of OpenCode sessions and model keys. It checks out the event's
`pull_request.head.sha`, records `git rev-parse HEAD` in `actual-sha.txt`, and
fails if that differs from `expected-sha.txt`. It never substitutes GitHub's
temporary merge commit. Checkout credentials are not persisted; the only token
permission in the candidate-code job is `contents: read`, including for forks.
No model secrets are passed.

The pinned PostgreSQL 18.3 service is disposable. `mise run smoke` creates its
own random database and temporary Rails/Vite/Chromium processes, probes SQL and
HTTP readiness, then cleans up only those resources. No persistent development
services or local credentials are used. See [smoke](chromium-smoke.md) and
[checks](checks.md).

## Read the evidence before merge

1. Open **Actions → PR head browser evidence**, select the PR's latest run, and
   download `browser-evidence-<sha>-<run_id>-<run_attempt>`.
2. Compare **both** `actual-sha.txt` and `expected-sha.txt` to the **current PR head**.
   A green check or old artifact alone is not evidence for a newer revision.
3. Read `result.json` and the per-phase logs/results. Open a `.trace.zip` with
   `mise exec -- node frontend/node_modules/playwright/cli.js show-trace <path>`.
   Tracing explicitly uses `on`, including successful tests, with screenshots
   and snapshots. A failed browser test also retains its trace and screenshot.
4. A failed setup may have only SHA files and Actions logs; absence of browser
   traces is not a pass. Artifacts upload even after failure and expire after
   14 days. Cancellation may interrupt evidence collection; never accept it
   as success. The owner still decides whether to merge.

Normal human pushes trigger a new PR run/artifact and cancel older runs for
that PR. **GITHUB_TOKEN**-created PRs/pushes do not automatically cascade into
new workflow runs. The owner must manually confirm a pending run or **re-run**
where available. A re-run **does not update** its original event's head SHA:
after another push, verify that a run exists for the new head. Never accept an
old re-run as fresh evidence.

If no PR run exists for the new SHA, the repository owner can open **Actions →
PR head browser evidence → Run workflow**, select the **default branch**, enter
the open PR number in `pr`, and run it. This owner-only `workflow_dispatch`
entrypoint resolves the PR's **live** head through the GitHub API before any
candidate checkout. It accepts only open, same-repository PRs; forks remain
supported by the normal `pull_request` path. Non-owner dispatches, non-owner
re-runs of dispatches, and dispatches from another branch skip the browser job.
The resolution job executes only inline default-branch policy, has
`pull-requests: read`, and passes only the validated SHA—not its API token—to
the candidate-code job. The same actual/expected SHA files and artifact naming
apply. A PR can advance during a run: always compare to current head again.
There is no automatic dispatch cascade or workflow-trigger API call.

## Local reproduction

After `mise run install`, with Docker Engine available:

```sh
SMOKE_EVIDENCE_DIR="$PWD/browser-evidence" mise run smoke
mise exec -- ruby test/browser_workflow_test.rb
mise exec -- ruby test/browser_evidence_integration_test.rb
```

The evidence directory is opt-in; normal smoke cleanup remains unchanged.
Exported logs redact the disposable database URL/password. Only synthetic
browser fixtures are captured; the runtime environment and private Rails files
are not uploaded. Do not run evidence capture against real user data.

The existing browser suite covers available selection → guest form, occupied
intervals, back navigation/`aria-pressed`, and keyboard access. This ticket
does **not** add #14's new indicator assertions: those arrive with #14 and its
red/green demonstration in #21. Visual color/contrast review remains human work.
Local checks do not establish that an external Actions run has succeeded.
