# Approved implementation and human-requested PR fixes

The implementation runner is separate from discussion/publication. In a source
issue, a trusted human sends a whole-comment command:

```text
/oc implement-spec #SPEC tickets #TICKET,#TICKET approval https://github.com/OWNER/REPO/issues/SOURCE#issuecomment-ID
```

Replace the placeholders with the existing artifact numbers. `/opencode` is
also accepted. The linked source-owner comment must explicitly approve the
specification and ticket list (supported form: `Одобряю спецификацию #N и
тикеты #A,#B` or `Approve specification #N ... #A,#B`; numeric ranges are
accepted, as is an optional `/oc` prefix). Only the bounded approval clause and
the optional sentence `Начинаем реализацию.` / `Можно реализовывать.` /
`Implementation approved.` are accepted; arbitrary subsequent qualifications
fail closed rather than treating excluded ticket mentions as approval.
Labels and bot replies are not approval. Unsupported/ambiguous
approval wording fails closed and needs human clarification, not model inference.

Both kinds of PR comment accept:

```text
/oc fix
Describe the correction here.
```

For inline comments the file, line, original line, side and diff hunk are supplied
by GitHub. The current comment and complete ordinary/inline/review discussions
are collected alongside source/spec/ticket discussions. PR fixes require a
same-repository task branch and the source provenance emitted by the publisher.
Arbitrary PR bodies cannot authorize a different task: approval is revalidated.

## Separation of authority

1. A trusted default-branch adapter validates the command, source-owner approval,
   graph (external blockers must be closed), PR trust and exact SHA.
2. The shared budget scans all Actions pages and every `run_attempt`'s jobs.
   A non-skipped `agent-admission:SCOPE:MODE` job reserves an attempt, including
   cancelled and timed-out jobs. The current attempt is counted exactly once.
   Three reservations are allowed; four fail without CLI installation or a model
   call. Missing/ambiguous history fails as `infra`. Both PR comment channels use
   `pr-N:interactive`; review uses its own `pr-N:review`. Initial issue work has
   a separate finite `issue-N` scope because no PR exists yet.
3. The CLI runs in a read-only container from trusted configuration, with an
   editable `/workspace` snapshot and read-only `/context`. It receives the model
   key but no GitHub token. Model tools cannot run shell, load candidate plugins,
   edit policy/runtime/credential paths or publish. Head config is never the
   process working directory. The model performs implementation and internal
   standards/spec review; it must not claim it ran tests.
   Before model access, trusted snapshot validation permits only the repository's
   protected `.claude/skills/NAME → ../../.agents/skills/NAME` aliases, with an
   existing internal directory target and no symlinked ancestors. Both paths
   remain non-editable by model tools. All other snapshot symlinks, including
   public aliases to protected files, dangling/chained links and `.git` symlinks,
   fail closed. The real `.git` directory is not traversed. Validation does not
   remove or dereference repository aliases.
4. A separate job without model/publication secrets applies the complete patch
   and runs the normal policy and aggregate checks against disposable PostgreSQL.
5. An independent no-model reporter publishes success or
   `limit_exhausted`/`timeout`/`infra`/`agent_failed`, current PR SHA (or last known
   source SHA), run URL and a request for human action.

The profile is reusable: task numbers and approval links are runtime data.
Infrastructure/policy edits require a separately reviewed local change; this
agent cannot rewrite the policy that admits and accounts for its own requests.

## Separate publication permission

After inspecting the successful implementation/check run, the repository owner
manually runs **Publish verified implementation with owner permission** from
the default branch, supplying its run ID and candidate base SHA. `allow_push`
authorizes only that verified task/head branch. `allow_pr` separately authorizes
a new draft PR; neither flag authorizes merge. The publisher has no model, does
not run candidate code, rejects policy paths, revalidates approval and live head,
and uses the exact immutable artifact of the successful attempt.

The publisher preserves Git history and refuses a changed head. Its compare-and-
swap push requires the expected branch tip (or absence for a new branch).
After publication, CI and independent review must verify the new SHA. With
`GITHUB_TOKEN`, confirm the pending workflow runs or explicitly rerun as owner;
there is no automatic workflow-dispatch cascade. Do not accept an older artifact.

Actions history retention and the trusted workflow/configuration are preconditions
of this finite budget, not an account-wide spending cap. Repository administrators
can change those preconditions. The interactive queue uses GitHub's `queue: max`
to avoid replacing pending fixes; the documented platform limit is 100 pending
items. Review cancellation uses a different concurrency group.

The pinned actionlint predates `concurrency.queue`. `ci:validate` ignores only
its unknown-key diagnostic for that specific key; policy tests enforce `max`
and `cancel-in-progress: false` in the two publication/implementation queues.
All other actionlint diagnostics remain errors.
