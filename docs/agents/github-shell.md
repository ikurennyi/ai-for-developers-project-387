# GitHub agent shell calls

Before using shell in a GitHub runner:

- Execute one allowed `gh` command per shell tool call.
- Pass literal, correctly quoted arguments. Do not add pipes, command chains
  (`;`, `&&`, `||`), redirections or command substitutions.
- Read command output directly. Use the dedicated grep tool for repository
  searches, not the shell executable `grep`.
- Do not add helper commands such as `echo`, `cat`, `sed` or `jq`.
- After `Permission denied`, retry only the allowed command on its own, or
  report the blocker. Do not expand permissions or try another execution path.

For a publication profile, check capabilities with separate calls:

```sh
gh issue create --help
```

```sh
gh issue edit --help
```

These instructions do not grant permissions: read-only profiles cannot run
these help calls. Keep their shell allowlists read-only.
