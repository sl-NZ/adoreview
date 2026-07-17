# Security

adoreview is a **local, single-user** tool. Its security model is intentionally
small:

- **Loopback only.** The server binds to `127.0.0.1`. It is never meant to be
  reachable from the network. Do not put it behind a public reverse proxy.
- **Your own identity.** All ADO calls act as you — via a short-lived Entra
  token from your `az login`, or an optional PAT you provide. adoreview grants no
  access you don't already have.
- **No secrets at rest (by default).** With `az`, nothing is written to disk; the
  token lives in memory. If you opt into `ADO_PAT`, it lives only in your
  gitignored `.env` and is never logged.
- **Local state.** Per-file "reviewed" flags live in a local SQLite file
  (`data.db`, gitignored). No PR content is persisted beyond your git clones.

## Reporting a vulnerability

Please open a private report to the maintainers rather than a public issue.
Because the tool runs locally as you, the most valuable reports concern: a way to
make the server reachable off-loopback, a path that logs or persists a token, or
a way for observed content (a PR title, a diff, a comment) to trigger unintended
action. Include repro steps.
