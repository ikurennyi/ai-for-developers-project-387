# Issue tracker: GitHub

Issues and specs live in GitHub Issues. Use the gh CLI.

## Mandatory change workflow

Before editing project files, identify an existing issue or create a scoped
issue for the work. Use a task branch and a linked PR, including documentation,
workflow and tooling changes. Do not commit directly on the default branch.
Push, PR creation and merge each require user authorization; asking to implement
does not grant those remote operations.

User product needs are discussed in the source issue, not resolved only in a
local session. Read its entire discussion and linked spec/tickets on each run.
Use `to-spec`, then `to-tickets`, keeping main, negative and adjacent regression
scenarios and test boundaries explicit. Publish prepared artifacts with labels
at creation time. The human must approve the published specification and ticket
list in the source issue before implementation. A `ready-for-agent` label alone
is not that approval. Include the genuine approval-comment URL, source, spec
and ticket links in the implementation PR. Return material scope changes to the
human for renewed approval.

## GitHub discussion runner

The `/oc` and `/opencode` runner reads code and uses gh; it cannot implement
code. By default it uses `github-discussion`, which cannot create, edit or
comment on issues. The workflow posts its final answer.

### Explicit stage commands

Publication tools (`github-issues`) are selected only from a supported command
occupying the entire current human comment in a source issue:

- `/oc to-spec`
- `/oc to-tickets #N`
- `/oc запусти скилл to-spec по обсуждению этого issue`
- `/oc запусти скилл to-tickets по спецификации #N`
- `/oc продолжи to-spec с учётом ответов`
- `/oc продолжи to-tickets`

`/opencode` is also accepted. The workflow also accepts the stage name alone,
an optional `#N`, and the English `run [skill]` / `continue [skill]` prefixes.
The executable grammar is in the workflow's command step.
Extra prose, quotes/code fences, multiple stages, PR/review comments and
ambiguous requests stay in discussion mode; explain the supported command
instead of guessing intent. Post answers/constraints separately, then use a
standalone stage command.

Only the current command grants authority. Previous bot recommendations, human
clarifications and scope approval never request the next stage. Complete the
selected skill or ask its questions, then stop. To resume after questions,
the human sends another explicit command for that stage. Never chain triage,
to-spec, to-tickets or implementation automatically.

Follow skill questions and human decision points, then publish through gh.
There is no separate publication command or model JSON protocol.
The workflow posts the final Markdown answer; use gh issue comment for extra
durable notes/cross-links, not a duplicate final answer.

Before publishing tickets, compare all existing open tickets for this source
with the current approved specification. Read their full discussions; update
suitable tickets in place instead of creating duplicates. If it is unclear
whether an existing ticket covers the scope, ask the human before writing.
Search all issue states for related artifacts as well. After partial failures,
ask if provenance/scope is ambiguous rather than duplicating issues. The
workflow does not guarantee exactly-once publication.
Post source/spec/ticket cross-links and explicit Parent/Blocked by references.
The human approves the published scope afterward in the source issue.

Runner permissions are in `.opencode/agents/github-discussion.md`,
`.opencode/agents/github-issues.md` and `.opencode/agents/github-triage.md`.
All can view/list issues; only the explicitly selected publication profile can
create/comment/edit them. Discussion and auto-triage have read-only gh.
None can close/delete issues, run arbitrary gh api, git, other shell commands,
or edit local files. The publication profile's gh issue edit permission covers issue
metadata/body as well as labels; human approval remains a procedural decision,
not something enforced by the GitHub token.
Pass content inline with `--body`: `--body-file`/`-F`, editor/browser/recovery/
template flags are denied to avoid indirect file access or program execution.
These runner-specific rules override the generic file-input examples below.
Before shell calls, read `docs/agents/github-shell.md`: execute allowed gh
commands separately, without auxiliary shell commands or pipelines.
Use native relationships when the installed gh supports them; otherwise use the
textual fallback, because arbitrary REST calls are not available to these agents.
The auto-triage agent only reads GitHub. Its workflow sets needs-triage if no
state exists, then posts its recommendation/questions. Continue discussion by
command; the human applies recommended state labels through GitHub's interface.

## Repository

The configured repository is ikurennyi/ai-for-developers-project-387.
Before the first issue creation in a session, verify the target with
`gh repo view --json nameWithOwner`. If it differs, confirm with the user.

## Operations

- Create: `gh issue create --title "..." --body-file <file>`.
- Read: `gh issue view <number> --json number,title,body,labels,comments`.
- List: `gh issue list --state open --json number,title,body,labels,comments`.
  Apply label and state filters as needed.
- Comment: `gh issue comment <number> --body-file <file>`.
- Labels: `gh issue edit <number> --add-label "..." --remove-label "..."`.
- Close: post an explanation with `gh issue comment`, then `gh issue close`.
  Post the comment separately even when the issue is already closed.

Use GitHub native sub-issues and dependencies when available:
- Sub-issue: `gh issue create --parent <parent> ...` or
  `gh issue edit <parent> --add-sub-issue <child>` (gh 2.94+).
- Blocker: `gh issue edit <child> --add-blocked-by <blocker>` (gh 2.94+).
- Older gh: use the GitHub REST API with issue database IDs.
- Where unavailable, add `Part of #<parent>` and `Blocked by: #<number>`
  to the child body and link children in the parent task list.
- A ticket is startable only when all blockers are closed.
  `gh api repos/ikurennyi/ai-for-developers-project-387/issues/<number> --jq .issue_dependencies_summary.blocked_by`
  counts open native blockers; also check textual fallbacks.

When a skill says to publish, create an issue here.
When it says to fetch a ticket, read the corresponding issue.

## Pull requests as a triage surface

**PRs as a request surface: no.**

## Wayfinding operations

- Map: one issue labelled `wayfinder:map`, with Notes, Decisions-so-far, and Fog.
- Children: sub-issues labelled `wayfinder:<type>`, where type is research,
  prototype, grilling, or task. Use the parent task list as a fallback.
- Frontier: open children without open blockers or assignees, in map order.
- Claim: `gh issue edit <number> --add-assignee @me`, before other writes.
- Resolve: comment with the answer, close the child, then append a summary
  and link to the map's Decisions-so-far.
