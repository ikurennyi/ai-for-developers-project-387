# Independent pull-request review (#19)

`.github/workflows/agent-review.yml` starts a fresh ordinary OpenCode CLI session
on opened/reopened/updated/ready PRs. It does not use `opencode github run`, resume
the implementation session, implement fixes, or dispatch another workflow.
The explicit policy is root `REVIEW.md`; `.opencode/agents/github-review.md`
allows only read and read-only external-directory access to the candidate.
Shell, network, edits, skills, MCP and delegation are denied by default.

## Trust, context and publication

The workflow checks out default-branch policy to `policy`, and the admitted exact
head SHA to `candidate`. It runs all scripts from trusted policy and OpenCode
in a read-only container with managed policies and read-only candidate/context
mounts (`/workspace`, `/context`),
never loads candidate configuration or instructions, and never executes PR code.
Checkouts retain no Git credentials. Only the model step receives
`OPENCODE_API_KEY`; it receives no GH_TOKEN. A separate trusted collector reads
the PR, paginated discussion/reviews/files, recursively linked same-repository
issues and approval comments, and exact-SHA checks/statuses/Actions evidence.
Collection is bounded at 40 linked issues; unavailable or omitted context and
patches are explicitly reported as gaps, never fabricated approval/success.

The shared `tooling/agent-policy.mjs` owns trust and Actions-history budgeting;
`tooling/agent-review.mjs` is only the review adapter. Same-repository trusted
human authors and `github-actions[bot]` are eligible. Forks are rejected before
model installation/credentials. No blanket bot exclusion is used.

A separate trusted publisher executes `gh pr comment` with argument-array
invocation and the comment body on stdin, identifying the SHA and Actions logs.
It rechecks current trust and head SHA first; cancelled or stale runs do not
publish. Publication uses GITHUB_TOKEN with pull-requests write, alongside
contents/issues/actions/checks/statuses read. No OIDC, separate App or
RELEASE_PLEASE_TOKEN is used. Model tools cannot publish.

## Budget and manual operation

The review budget is **three admitted attempts per PR**, independent of the
executor's three interactive attempts. All workflow-run pages and every attempt's
jobs prove admission, including cancelled/timed-out runs and re-runs. The dynamic
job name `agent-admission:pr-N:review` reserves an attempt. The current attempt
must appear exactly once; incomplete history fails closed before model install.
Conservative reservation may consume budget even when a model never starts.
Exhaustion posts `limit_exhausted`; unprovable history posts `infra`.

Concurrency is distinct from the interactive queue: one review per PR with
`cancel-in-progress: true`, a 15-minute job timeout and a final SHA check.
The model command has its own ten-minute `timeout` (TERM, then KILL after twenty
seconds), leaving time for the always-run publisher rather than relying on the
outer job timeout.
Different PRs have independent groups. Missing credentials/CLI or failed
context/install preparation report `infra`; timeout exit 124 reports `timeout`;
other failed/empty model results report `agent_failed`. Explicit model-started
and verdict outputs prevent a setup failure from masquerading as a model failure.
GitHub cancellation/outer timeout can prevent the publisher
itself from running; inspect the Actions conclusion/logs in that case.

GITHUB_TOKEN-created PRs/pushes do **not** automatically start follow-up Actions.
The repository owner can run **Independent PR review → Run workflow**, selecting
the default branch and entering the PR number. The adapter independently checks
owner identity and default branch. A permitted re-run also consumes another
attempt. Never add a bot comment, workflow_run, repository_dispatch or automatic
dispatch loop to bypass this human confirmation. Reviews themselves never request
fixes; an explicit human command is required.

Only a human provisions secrets/settings, authorizes remote publication, and
decides merge. Local policy tests do not establish live Actions/model behavior.
Before merge compare the current head SHA with this review, CI and browser
artifacts; pending/missing evidence is not green evidence.

## Local verification

`mise exec -- ruby test/review_workflow_test.rb` checks the workflow boundary:
events/manual authorization, checkout trust, least privileges, model isolation,
criteria, shared budget use, no cascade, and stale-head publication protection.
It also runs the real adapter/shared policy against fixture GitHub HTTP responses
and a recording `gh` executable, plus the actual model-step shell with fixture
container/timeout commands. These cover automation trust, rejected forks/dispatches,
attempt exhaustion/history failure, context gaps, verdicts, and stale/cancelled
publication suppression without network or model credentials.
The main integration wires this suite into `mise run ci:validate`.
Live approval/dispatch, automation-authored PR review, cancellation on push and
secret provisioning remain external acceptance steps, not local test claims.
