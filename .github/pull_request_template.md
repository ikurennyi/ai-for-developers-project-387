## Provenance and approved scope

- Source issue:
- Specification:
- Tickets:
- Genuine human approval-comment URL (not a label or bot recommendation):
- Closes #<!-- only issues this PR actually completes -->

## Change and evidence

- What changed and why:
- Exact tested head SHA:
- Commands and results (including failures or skipped checks):
- Logs / Actions / browser artifact URLs:
- Independent review and resolved findings:
- Evidence gaps / pending external checks:

For GITHUB_TOKEN-created PRs, the owner manually dispatches/approves fresh checks
and independent review after each push; no automatic cascade is assumed.
Compare every review/check/artifact SHA with the current PR head before merge.

## Risk and recovery

- Risk stated as user/operational consequences:
- Git rollback command/commit(s):
- Verification that rollback restores expected behavior:
- Data implications: migrations, retained/changed data, backups and recovery:

Git revert does not restore data. State explicitly if there are no data changes;
otherwise describe the separate data recovery procedure and its limitations.
Merge and any destructive recovery require a human decision.
