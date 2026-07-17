# Contributing to adoreview

Thanks for helping. This is a small, deliberately low-ceremony project: one
runtime (Bun), no build step for the app code, no framework. If you can read
plain TypeScript and vanilla DOM JavaScript, you can contribute.

## Dev setup

```sh
mise install     # Bun
bun install
cp .env.example .env   # set ADO_ORG + ADO_PROJECT (see README → Authentication)
mise run dev     # http://localhost:4680, restarts on server-side changes
bun test         # run the suite (keep it green)
```

`mise run dev` uses `bun --watch`, so edits to `server.ts` / `ado.ts` restart the
server. UI files (`ui/*.js`, `ui/*.css`) are served fresh — just reload the page.
Reload with a real refresh (⌘⇧R), not a same-`#hash` navigation, or the browser
won't re-fetch the scripts.

## Architecture

Three files do the work:

- **`ado.ts`** — the data layer. Auth (`az` token or PAT), ADO REST calls, local
  `git` diff/content extraction, and all the in-memory caches. Pure-ish and
  unit-tested (`ado.test.ts`). This is where ADO's quirks live (documented
  inline: deletes carry the path in `originalPath`, renames are `edit, rename`,
  completed PRs lose their refs but SHAs still fetch, etc.).
- **`server.ts`** — a thin Bun HTTP server on loopback. Routes under `/api/pr/…`,
  a SQLite table for per-file reviewed-state, static file serving, and the
  startup bundle of `@pierre/diffs` for the browser.
- **`ui/`** — the client. `app.js` (views, state, rendering via `@pierre/diffs`
  CodeView), `keyboard.js` (pure, tested shortcut helpers on `window.Adoreview‑
  Keyboard`), `style.css`, `index.html`.

Data flows: `ado.ts` caches by immutable iteration id (content) and short TTLs
(social); writes invalidate the bundle cache; the client caches per session and
polls a cheap fingerprint (`/api/pr/:id/pulse`) for others' activity.

### The one rule that will bite you

`@pierre/diffs` mutators **store, never paint**. After `setLineAnnotations`,
`updateItem`, or `setItems`, you must call `rerender()` / `render(true)` or the
DOM won't move. There are comments at each call site; keep the pattern.

## Conventions

- **Vanilla JS + DOM** in the UI, no framework, no bundler for app code. The `el()`
  helper builds elements; match the surrounding style.
- **Keyboard shortcuts** are single lowercase keys. Add them in `keyboard.js`
  (`oneShotShortcuts`, `normalizeShortcut`) and dispatch in `app.js`'s keydown
  handler, then add a row to the in-app help and a test.
- Keep it **fast and local**: don't add a network round-trip to the render path,
  don't introduce a hosted dependency, don't store secrets.

## Common changes

- **A file-type icon:** add an extension → icon-name entry to `MATERIAL_ICON` in
  `app.js` (icon names come from `material-icon-theme`).
- **A keyboard shortcut:** see Conventions above; cover it in `keyboard.test.ts`.
- **An API route:** add a branch in `server.ts`'s `/api/pr/:id/…` matcher and the
  backing function in `ado.ts`.

## Pull requests

- Run `bun test` and make sure it's green.
- Keep changes focused; explain the *why* in the description.
- No internal/company identifiers in code, tests, or fixtures.
- UI change? Include a before/after screenshot.
