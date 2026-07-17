# adoreview

A fast, keyboard-first, local pull-request review tool for **Azure DevOps** — the
fast, keyboard-first review experience modern tools made normal for GitHub, brought to ADO.

It runs entirely on your machine, authenticates as *you*, and stores nothing in
the cloud. Open a PR and the diff is already there; review it without touching a
mouse; comment, resolve, and approve — all landing in ADO as if you'd used the
web UI.

> Status: **experimental**. It began as a spike and grew into a daily driver. The
> data layer and review flow are proven against a real, large ADO org; expect
> rough edges and moving parts. Contributions welcome.
>
> Honestly: this was **vibe coded** — built almost end to end through an extended
> pair-programming session with Claude (Claude Code), then verified live against a
> real ADO org. Read it with that in mind: the architecture is deliberate and the
> critical paths were tested by hand, but it hasn't had a traditional line-by-line
> human review yet. That's part of what contributions are for.

## Why this exists

Azure DevOps' web pull-request experience is slow and mouse-bound, and that cost
compounds in the agentic era: when code is written faster, *review* becomes the
bottleneck, and a sluggish review UI throttles the whole team. Meanwhile the fast
review renaissance — diffs.com, Graphite, ReviewStack —
skipped ADO entirely. There is no good, fast, keyboard-driven review surface for
Azure DevOps.

The insight behind adoreview is that ADO's slowness is the *client*, not the
platform. Its REST API is quick (70–350 ms/call); its web SPA is what drags.
And you don't even need the API for file content: your local clones already have
it. So the whole thing can be a small local tool:

- **Auth** is your existing `az login` — no PATs, no stored secrets, Conditional
  Access intact.
- **File content and diffs** come from local `git`, computed in milliseconds.
- **The social layer** (threads, votes, statuses) comes from the REST API.
- **Rendering** is the real diffs.com engine ([`@pierre/diffs`](https://diffs.com)).

What's left for adoreview to own — and the part nobody had built — is the
Azure-DevOps-specific glue: turning `az` tokens, local clones, and ADO's thread
API into one fast review surface. That's the project.

Design principles, in priority order: **fast** (prefetch, cache by immutable
iteration id, never block the first paint), **keyboard-first** (every action has
a single-key binding), **local and private** (loopback-only, your own auth,
nothing at rest), and **few moving parts** (one runtime, no build step, two
dependencies).

## How it works

Three planes, deliberately separated:

| plane | source | freshness |
| --- | --- | --- |
| **auth** | `az` CLI Entra token (or an optional PAT) | token refreshed ~hourly |
| **content** (diffs, file text, highlighting) | your local git clones | cached per iteration id (immutable) |
| **social** (threads, votes, work items) | ADO REST API | polled every 30 s while a PR is open |

A push creates a new ADO *iteration*, so content is keyed by `prId:iterationId`
and cached forever — it only changes when the code does. The social layer is
polled with a cheap fingerprint (ADO serves no ETag on threads); when a teammate
comments or pushes, a non-intrusive banner offers a reload.

## Requirements

- [mise](https://mise.jdx.dev) (manages the one tool: Bun) — or Bun ≥ 1.3 directly
- The **Azure CLI** (`az`), logged in — *or* a Personal Access Token (see below)
- Local git clones of the repos you review, under one root (default `~/Projects`)

## Quick start

```sh
git clone <this repo> && cd adoreview
mise install            # installs Bun
bun install             # installs @pierre/diffs + shiki + material-icon-theme
cp .env.example .env     # then edit: set ADO_ORG and ADO_PROJECT
az login                 # if you're using the default auth path
mise run dev             # → http://localhost:4680
```

Open `http://localhost:4680`, press `?` for the full keymap. Deep links work:
`#pr/1234` opens a PR's overview, `#pr/1234/diff` its diff.

## Authentication

adoreview never asks you to paste a token into a web form, and by default keeps
no secret on disk. Two modes, chosen automatically:

1. **`az login` (default, recommended).** The server mints a short-lived Entra
   token from your Azure CLI session for each burst of API calls. Conditional
   Access and MFA apply exactly as they do in the browser. Nothing is stored;
   the token lives in memory and refreshes before it expires. This is the whole
   point — set `ADO_ORG`/`ADO_PROJECT` and you're done.

2. **Personal Access Token (fallback).** If you can't run `az` (a headless box,
   CI, a locked-down machine), set `ADO_PAT` in your `.env`. It's used via HTTP
   Basic, never logged, and read only from the gitignored `.env`. Scope it
   minimally: Code (Read) + Pull Request Threads (Read & Write). Treat it like a
   password — if it leaks, revoke it in ADO.

The server prints which mode it's using on startup and refuses to start with a
clear message if `ADO_ORG`/`ADO_PROJECT` are missing.

## Keyboard-first

Everything is one lowercase key. A taste (`?` in-app shows the rest):

- Inbox: `j`/`k` move · `⏎` open · `/` filter · `a` mine ↔ all
- Diff: `j`/`k` files · `↑`/`↓` pick a line · `c` comment · `v` reviewed+next ·
  `n`/`p` threads · `x` collapse · `t` collapse all · `s` stacked/split
- Comments: `⏎` send · `⇧⏎` newline · `esc` discard

## What it is and isn't

It **is** a fast personal/team review client: browse, read, comment, reply,
edit, resolve, and (soon) vote on PRs. It **is not** a hosted service, a CI bot,
or a replacement for ADO — ADO remains the system of record; adoreview is just a
better window onto it.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the architecture, dev setup, and how
to add a file-type icon, a keyboard shortcut, or an API route. Run `bun test`
before opening a PR.

## License & credits

MIT — see [LICENSE](LICENSE). Built on the shoulders of:

- [`@pierre/diffs`](https://diffs.com) — the diff renderer (Apache-2.0)
- [`shiki`](https://shiki.style) — syntax highlighting (MIT)
- [`material-icon-theme`](https://github.com/material-extensions/vscode-material-icon-theme) — file-type icons (MIT)
