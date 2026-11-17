# Triage Labels

Map canonical triage roles to this repository's labels:

| Role | Tracker label | Meaning |
| --- | --- | --- |
| needs-triage | needs-triage | Maintainer evaluation needed |
| needs-info | needs-info | Waiting on reporter information |
| ready-for-agent | ready-for-agent | Fully specified; ready for an autonomous agent |
| ready-for-human | ready-for-human | Requires human implementation |
| wontfix | wontfix | Will not be actioned |

When a skill names a role, apply the corresponding tracker label.

Prepared artifacts also use `agent:spec` for specifications and `agent:ticket`
for tickets, together with `ready-for-agent`. Pass these labels to gh issue
create, not in a later edit. A prepared label is not human scope approval.

The fresh-label gate in `.github/workflows/issue-triage.yml` skips closed issues
and issues with ready-for-agent, ready-for-human, agent:spec, agent:ticket or
wontfix before calling the model. It reads live labels after acquiring the
shared issue concurrency group, not just the opening event's snapshot.

All these labels are configured in this repository. For a new repository,
a maintainer creates missing labels with `gh label create <name>` before enabling
the workflows; the model has no label-management command permission.

Automatic triage is preliminary: the workflow adds needs-triage only when no
state exists. The read-only model recommends a category/state and asks questions;
it cannot promote, close or edit issues. Apply recommendations through the manual
agent with human direction. Conflicting states require human review.
After answering questions, invoke `/oc` to continue; plain replies do not spend
model tokens automatically.
