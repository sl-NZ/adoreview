/**
 * Data layer for the local ADO review app.
 *
 * Three sources, per the spike's findings:
 *   - `az`        → Entra token (auth plane; no PATs, no stored secrets)
 *   - ADO REST    → PR metadata, iterations, changed files, threads (social plane)
 *   - local git   → all file content and diffs, from clones you already have
 *
 * Everything mutable is cached with short TTLs; everything keyed by an
 * iteration id is immutable and cached forever (a push creates a NEW iteration).
 */

import { $ } from "bun";
import { getSingletonHighlighter, type Highlighter } from "shiki";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";

// ─────────────────────────── config ───────────────────────────
// Per-user config comes from the environment (Bun auto-loads `.env`).
// Copy `.env.example` → `.env` and fill it in. The only optional secret is
// ADO_PAT — the default auth path stores nothing and uses your `az login`.
export const ORG = process.env.ADO_ORG ?? "";
export const PROJECT = process.env.ADO_PROJECT ?? "";
const PROJECTS_ROOT = process.env.ADO_PROJECTS_ROOT || `${process.env.HOME}/Projects`;
const ADO_PAT = process.env.ADO_PAT?.trim();
export const AUTH_MODE = ADO_PAT ? "pat" : "az";
const ADO_RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798"; // well-known Entra app id for Azure DevOps

/** Human-readable reason config is incomplete, or null when it's usable. */
export function configError(): string | null {
  if (!ORG) return "ADO_ORG is not set (your dev.azure.com organization)";
  if (!PROJECT) return "ADO_PROJECT is not set (the ADO project to review PRs in)";
  return null;
}

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

// ─────────────────────────── auth ───────────────────────────
// Two modes, in priority order:
//   1. az  (default) — mint a short-lived Entra token from your existing
//          `az login`. Nothing is stored; Conditional Access / MFA apply.
//   2. PAT — if ADO_PAT is set (no az CLI, or headless/CI), use it via HTTP
//          Basic. Keep it only in the gitignored `.env`; it is never logged.

let tokenCache: { v: string; exp: number } | null = null;
async function authHeader(): Promise<string> {
  if (ADO_PAT) return `Basic ${btoa(":" + ADO_PAT)}`; // ADO PAT = HTTP Basic, empty username
  if (tokenCache && Date.now() < tokenCache.exp) return `Bearer ${tokenCache.v}`;
  const raw = await $`az account get-access-token --resource ${ADO_RESOURCE} -o json`.quiet().text();
  const t = JSON.parse(raw);
  // refresh 5 minutes before expiry
  tokenCache = { v: t.accessToken, exp: new Date(t.expiresOn).getTime() - 5 * 60_000 };
  return `Bearer ${tokenCache.v}`;
}

async function ado<T = any>(path: string, params: Record<string, string> = {}): Promise<T> {
  const url = new URL(`https://dev.azure.com/${ORG}/${path}`);
  url.searchParams.set("api-version", "7.1");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: await authHeader() } });
  if (!res.ok) throw new HttpError(res.status, `ADO ${res.status} on ${url.pathname}: ${(await res.text()).slice(0, 300)}`);
  return res.json() as Promise<T>;
}

async function adoPost<T = any>(path: string, body: unknown): Promise<T> {
  const url = new URL(`https://dev.azure.com/${ORG}/${path}`);
  url.searchParams.set("api-version", "7.1");
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: await authHeader(), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new HttpError(res.status, `ADO ${res.status} on POST ${url.pathname}: ${(await res.text()).slice(0, 300)}`);
  return res.json() as Promise<T>;
}

async function adoPatch<T = any>(path: string, body: unknown): Promise<T> {
  const url = new URL(`https://dev.azure.com/${ORG}/${path}`);
  url.searchParams.set("api-version", "7.1");
  const res = await fetch(url, {
    method: "PATCH",
    headers: { Authorization: await authHeader(), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new HttpError(res.status, `ADO ${res.status} on PATCH ${url.pathname}: ${(await res.text()).slice(0, 300)}`);
  return res.json() as Promise<T>;
}

async function adoDelete(path: string): Promise<void> {
  const url = new URL(`https://dev.azure.com/${ORG}/${path}`);
  url.searchParams.set("api-version", "7.1");
  const res = await fetch(url, { method: "DELETE", headers: { Authorization: await authHeader() } });
  if (!res.ok) throw new HttpError(res.status, `ADO ${res.status} on DELETE ${url.pathname}: ${(await res.text()).slice(0, 300)}`);
}

// ─────────────────────────── identity ───────────────────────────

let mePromise: Promise<{ id: string; name: string }> | null = null;
export function me() {
  mePromise ??= ado<any>("_apis/connectionData", { "api-version": "7.1-preview" }).then((d) => ({
    id: d.authenticatedUser.id as string,
    name: d.authenticatedUser.providerDisplayName as string,
  }));
  return mePromise;
}

// ─────────────────────── local clone discovery ───────────────────────

let reposPromise: Promise<Map<string, string>> | null = null;
export function localRepos(): Promise<Map<string, string>> {
  reposPromise ??= (async () => {
    const found = (await $`find ${PROJECTS_ROOT} -maxdepth 3 -name .git -not -path "*/node_modules/*"`.quiet().nothrow().text())
      .trim().split("\n").filter(Boolean).map((g) => g.replace(/\/\.git$/, ""));
    const map = new Map<string, string>();
    await Promise.all(found.map(async (dir) => {
      const url = (await $`git -C ${dir} remote get-url origin`.quiet().nothrow().text()).trim();
      const m = url.match(/dev\.azure\.com\/[^/]+\/[^/]+\/_git\/(.+?)$/i) ?? url.match(/ssh\.dev\.azure\.com:v3\/[^/]+\/[^/]+\/(.+?)$/i);
      if (m) {
        const name = decodeURIComponent(m[1]).toLowerCase();
        if (!map.has(name)) map.set(name, dir);
      }
    }));
    return map;
  })();
  return reposPromise;
}

// ─────────────────────────── PR list ───────────────────────────

function slimPr(pr: any, local: Map<string, string>) {
  return {
    id: pr.pullRequestId as number,
    title: pr.title as string,
    repo: { id: pr.repository.id as string, name: pr.repository.name as string },
    author: { id: pr.createdBy.id as string, name: pr.createdBy.displayName as string },
    created: pr.creationDate as string,
    source: (pr.sourceRefName as string).replace("refs/heads/", ""),
    target: (pr.targetRefName as string).replace("refs/heads/", ""),
    isDraft: !!pr.isDraft,
    status: pr.status as string,
    mergeStatus: (pr.mergeStatus as string) ?? "",
    description: (pr.description as string) ?? "",
    reviewers: ((pr.reviewers as any[]) ?? []).map((r) => ({
      id: r.id, name: r.displayName, vote: r.vote as number,
      required: !!r.isRequired, group: !!r.isContainer,
    })),
    url: `https://dev.azure.com/${ORG}/${PROJECT}/_git/${encodeURIComponent(pr.repository.name)}/pullrequest/${pr.pullRequestId}`,
    local: local.has((pr.repository.name as string).toLowerCase()),
  };
}
export type SlimPr = ReturnType<typeof slimPr>;

let prsCache: { at: number; data: SlimPr[] } | null = null;
export async function listPrs(): Promise<SlimPr[]> {
  if (prsCache && Date.now() - prsCache.at < 15_000) return prsCache.data;
  const [active, local] = await Promise.all([
    ado<{ value: any[] }>(`${PROJECT}/_apis/git/pullrequests`, { "searchCriteria.status": "active", $top: "200" }),
    localRepos(),
  ]);
  prsCache = { at: Date.now(), data: active.value.map((pr) => slimPr(pr, local)) };
  return prsCache.data;
}

// ─────────────────────────── PR bundle ───────────────────────────
// Metadata + threads + changed-file list + local commits, everything the diff
// view needs except file content.

export interface Thread {
  id: number; status: string; path?: string; side?: "right" | "left"; line?: number;
  comments: { author: string; date: string; content: string }[];
}
interface BundleEntry {
  at: number; iterationId: number; repoDir: string;
  shas: { src: string; tgt: string; base: string };
  data: any;
}
const bundles = new Map<number, BundleEntry>();

// serialize git fetches per repo — concurrent fetches into one repo can fight over locks
const repoLocks = new Map<string, Promise<unknown>>();
function withRepoLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const next = (repoLocks.get(dir) ?? Promise.resolve()).catch(() => {}).then(fn);
  repoLocks.set(dir, next);
  return next;
}

async function ensureCommits(repoDir: string, pr: any, src: string, tgt: string): Promise<void> {
  const have = async () =>
    (await $`git -C ${repoDir} cat-file -e ${src}^{commit}`.quiet().nothrow()).exitCode === 0 &&
    (await $`git -C ${repoDir} cat-file -e ${tgt}^{commit}`.quiet().nothrow()).exitCode === 0;
  if (await have()) return;
  await withRepoLock(repoDir, async () => {
    if (await have()) return;
    // refs first (works for active PRs), then SHAs (verified: ADO allows SHA-in-want,
    // which covers completed/abandoned PRs whose refs ADO has deleted)
    await $`git -C ${repoDir} fetch --no-tags --quiet origin +${pr.sourceRefName}:refs/adoreview/src +${pr.targetRefName}:refs/adoreview/tgt`.quiet().nothrow();
    if (await have()) return;
    await $`git -C ${repoDir} fetch --no-tags --quiet origin ${src} ${tgt}`.quiet().nothrow();
    if (!(await have())) throw new HttpError(502, `could not fetch PR commits into ${repoDir}`);
  });
}

export async function bundle(prId: number): Promise<BundleEntry> {
  const cached = bundles.get(prId);
  if (cached && Date.now() - cached.at < 45_000) return cached;

  const pr = await ado<any>(`_apis/git/pullrequests/${prId}`);
  const repoDir = (await localRepos()).get((pr.repository.name as string).toLowerCase());
  if (!repoDir) throw new HttpError(409, `no local clone of ${pr.repository.name} under ${PROJECTS_ROOT}`);

  const base = `${PROJECT}/_apis/git/repositories/${pr.repository.id}/pullRequests/${prId}`;
  const iterations = await ado<{ value: any[] }>(`${base}/iterations`);
  const latest = iterations.value[iterations.value.length - 1];

  const [changesRes, threadsRes, workItems] = await Promise.all([
    ado<{ changeEntries: any[] }>(`${base}/iterations/${latest.id}/changes`, { $compareTo: "0", $top: "3000" }),
    // $iteration/$baseIteration → ADO translates thread positions to the latest push
    ado<{ value: any[] }>(`${base}/threads`, { $iteration: String(latest.id), $baseIteration: "1" })
      .catch(() => ado<{ value: any[] }>(`${base}/threads`)),
    // linked work items (the PR's linked-issues panel in the overview)
    (async () => {
      try {
        const refs = await ado<{ value: any[] }>(`${base}/workitems`);
        if (!refs.value?.length) return [];
        const ids = refs.value.slice(0, 20).map((w) => w.id).join(",");
        const wi = await ado<{ value: any[] }>(`${PROJECT}/_apis/wit/workitems`, {
          ids, fields: "System.Title,System.State,System.WorkItemType",
        });
        return wi.value.map((w) => ({
          id: w.id, title: w.fields["System.Title"] as string,
          state: w.fields["System.State"] as string, type: w.fields["System.WorkItemType"] as string,
          url: `https://dev.azure.com/${ORG}/${PROJECT}/_workitems/edit/${w.id}`,
        }));
      } catch { return []; }
    })(),
  ]);

  // verified quirks: deletes carry path in originalPath (item.path is null);
  // renames are "edit, rename" with item.path = NEW path
  const changes = (changesRes.changeEntries ?? [])
    .filter((c) => (c.item?.path ?? c.originalPath) && !c.item?.isFolder)
    .map((c) => ({
      path: ((c.item?.path ?? c.originalPath) as string).replace(/^\//, ""),
      changeType: c.changeType as string,
    }));

  const fileThreads: Thread[] = [];
  const prLevel: Thread[] = [];
  const events: { date: string; text: string }[] = [];
  for (const t of threadsRes.value) {
    if (t.isDeleted) continue;
    // system comments ("X approved…", "Y voted…") feed the overview activity timeline
    for (const c of t.comments ?? [])
      if (c.commentType === "system" && c.content) events.push({ date: c.publishedDate, text: c.content });
    const comments = (t.comments ?? [])
      .filter((c: any) => c.commentType === "text" && !c.isDeleted && c.content)
      .map((c: any) => ({ id: c.id as number, author: c.author.displayName as string, authorId: c.author.id as string, date: c.publishedDate as string, content: c.content as string }));
    if (!comments.length) continue;
    const ctx = t.threadContext;
    const thread: Thread = { id: t.id, status: t.status ?? "unknown", comments };
    if (ctx?.filePath) {
      thread.path = (ctx.filePath as string).replace(/^\//, "");
      if (ctx.rightFileStart?.line) { thread.side = "right"; thread.line = ctx.rightFileStart.line; }
      else if (ctx.leftFileStart?.line) { thread.side = "left"; thread.line = ctx.leftFileStart.line; }
      fileThreads.push(thread);
    } else prLevel.push(thread);
  }

  const src = latest.sourceRefCommit.commitId as string;
  const tgt = latest.targetRefCommit.commitId as string;
  const baseSha = (latest.commonRefCommit?.commitId as string) ?? "";
  await ensureCommits(repoDir, pr, src, tgt);
  const diffBase = baseSha ||
    (await $`git -C ${repoDir} merge-base ${tgt} ${src}`.quiet().text()).trim();

  const entry: BundleEntry = {
    at: Date.now(), iterationId: latest.id as number, repoDir,
    shas: { src, tgt, base: diffBase },
    data: {
      pr: slimPr(pr, await localRepos()),
      iterations: {
        count: iterations.value.length, latestId: latest.id,
        list: iterations.value.map((it) => ({ id: it.id, author: it.author?.displayName ?? "", created: it.createdDate })),
      },
      changes,
      threads: { file: fileThreads, prLevel },
      events: events.sort((a, b) => Date.parse(a.date) - Date.parse(b.date)).slice(-30),
      workItems,
      shas: { src, tgt, base: diffBase },
    },
  };
  bundles.set(prId, entry);
  return entry;
}

// ─────────────────────────── write path: comments ───────────────────────────
// New line-anchored/PR-level thread, or a reply to an existing thread.
// Lands in ADO as the real signed-in user; server bundle cache is invalidated
// so the next fetch shows it.

export async function postComment(prId: number, body: {
  text: string; path?: string; line?: number; lineEnd?: number; side?: "right" | "left";
  threadId?: number; parentId?: number;
}) {
  if (!body.text?.trim()) throw new HttpError(400, "empty comment");
  const b = await bundle(prId);
  const base = `${PROJECT}/_apis/git/repositories/${b.data.pr.repo.id}/pullRequests/${prId}`;
  let out;
  if (body.threadId) {
    out = await adoPost(`${base}/threads/${body.threadId}/comments`, {
      content: body.text, parentCommentId: body.parentId ?? 1, commentType: "text",
    });
  } else {
    const tc: any = body.path ? { filePath: "/" + body.path } : undefined;
    if (tc && body.line) {
      const start = { line: body.line, offset: 1 };
      const end = { line: body.lineEnd ?? body.line, offset: 1 };
      if (body.side === "left") { tc.leftFileStart = start; tc.leftFileEnd = end; }
      else { tc.rightFileStart = start; tc.rightFileEnd = end; }
    }
    out = await adoPost(`${base}/threads`, {
      comments: [{ parentCommentId: 0, content: body.text, commentType: "text" }],
      status: "active",
      ...(tc ? { threadContext: tc } : {}),
    });
  }
  bundles.delete(prId);
  return out;
}

export async function updateComment(prId: number, threadId: number, commentId: number, text: string) {
  if (!text?.trim()) throw new HttpError(400, "empty comment");
  const b = await bundle(prId);
  const base = `${PROJECT}/_apis/git/repositories/${b.data.pr.repo.id}/pullRequests/${prId}`;
  const out = await adoPatch(`${base}/threads/${threadId}/comments/${commentId}`, { content: text });
  bundles.delete(prId);
  return out;
}

// "fixed" = ADO's Resolved; "active" reopens
export async function setThreadStatus(prId: number, threadId: number, status: "fixed" | "active" | "closed" | "wontFix" | "pending") {
  const b = await bundle(prId);
  const base = `${PROJECT}/_apis/git/repositories/${b.data.pr.repo.id}/pullRequests/${prId}`;
  const out = await adoPatch(`${base}/threads/${threadId}`, { status });
  bundles.delete(prId);
  return out;
}

// soft-deletes one of YOUR comments (ADO enforces ownership server-side)
export async function deleteComment(prId: number, threadId: number, commentId: number) {
  const b = await bundle(prId);
  const base = `${PROJECT}/_apis/git/repositories/${b.data.pr.repo.id}/pullRequests/${prId}`;
  await adoDelete(`${base}/threads/${threadId}/comments/${commentId}`);
  bundles.delete(prId);
  return { ok: true };
}

// Cheap freshness fingerprint for polling an open PR. ADO serves no ETag on
// threads (verified: cache-control no-store), so we compute our own stamp.
// Bypasses the bundle cache so it always reflects ADO *now*. Two REST calls:
// PR detail (lastMergeSourceCommit flips on a push) + threads (comments/status).
export async function pulse(prId: number) {
  const pr = await ado<any>(`_apis/git/pullrequests/${prId}`);
  const base = `${PROJECT}/_apis/git/repositories/${pr.repository.id}/pullRequests/${prId}`;
  const threads = await ado<{ value: any[] }>(`${base}/threads`);
  let comments = 0, maxUpd = 0;
  const statuses: string[] = [];
  for (const t of threads.value ?? []) {
    if (t.isDeleted) continue;
    maxUpd = Math.max(maxUpd, Date.parse(t.lastUpdatedDate ?? t.publishedDate ?? 0) || 0);
    statuses.push(`${t.id}:${t.status ?? ""}`);
    for (const c of t.comments ?? []) {
      if (c.isDeleted || c.commentType !== "text") continue;
      comments++;
      maxUpd = Math.max(maxUpd, Date.parse(c.lastUpdatedDate ?? c.publishedDate ?? 0) || 0);
    }
  }
  // one opaque string; the client only compares it for equality
  const stamp = [
    pr.lastMergeSourceCommit?.commitId ?? "", // push
    (threads.value ?? []).length, comments, maxUpd, // add/delete/edit
    statuses.join(","), // resolve/reopen
  ].join("|");
  return { stamp };
}

// ─────────────────────────── diff ───────────────────────────

export interface DiffLine { t: " " | "+" | "-"; old?: number; new?: number; text: string; hl?: [number, number] }
export interface Hunk { header: string; lines: DiffLine[] }
export interface FileDiff {
  path: string; oldPath?: string; status: string; binary: boolean;
  adds: number; dels: number; hunks: Hunk[];
  blob?: string; oldBlob?: string; // content identity — reviewed-state keys off this
}

export interface GitDiffIdentity {
  path: string;
  oldPath?: string;
  status: "add" | "delete" | "rename" | "copy" | "edit";
}

// `git diff --name-status -z` is the authoritative identity stream for a
// patch. NUL delimiters preserve spaces, tabs, newlines, non-ASCII names, and
// rename/copy pairs without having to reverse Git's display-path quoting.
export function parseGitNameStatus(raw: string): GitDiffIdentity[] {
  const fields = raw.split("\0");
  if (fields.at(-1) === "") fields.pop();
  const identities: GitDiffIdentity[] = [];
  let i = 0;
  while (i < fields.length) {
    const token = fields[i++];
    const code = token?.[0];
    if (!code) throw new Error(`invalid git name-status record at field ${i - 1}`);
    const paired = code === "R" || code === "C";
    const oldPath = paired ? fields[i++] : undefined;
    const path = fields[i++];
    if (!path || (paired && !oldPath))
      throw new Error(`incomplete git name-status ${token} record`);
    identities.push({
      path,
      ...(paired ? { oldPath } : {}),
      status: code === "A" ? "add"
        : code === "D" ? "delete"
        : code === "R" ? "rename"
        : code === "C" ? "copy"
        : "edit",
    });
  }
  return identities;
}

export function parseUnifiedDiff(raw: string, identities: GitDiffIdentity[]): FileDiff[] {
  const files: FileDiff[] = [];
  let f: FileDiff | null = null;
  let h: Hunk | null = null;
  let oldNo = 0, newNo = 0;
  for (const line of raw.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const identity = identities[files.length];
      if (!identity)
        throw new Error(`git patch has more files than name-status metadata (${files.length + 1})`);
      f = {
        path: identity.path,
        oldPath: identity.oldPath ?? (identity.status === "add" ? undefined : identity.path),
        status: identity.status,
        binary: false,
        adds: 0,
        dels: 0,
        hunks: [],
      };
      files.push(f); h = null;
    } else if (!f) continue;
    else if (line.startsWith("new file mode")) f.status = "add";
    else if (line.startsWith("deleted file mode")) f.status = "delete";
    else if (line.startsWith("rename from ")) { f.status = "rename"; f.oldPath = line.slice(12); }
    else if (line.startsWith("rename to ")) f.path = line.slice(10);
    else if (line.startsWith("copy from ")) { f.status = "copy"; f.oldPath = line.slice(10); }
    else if (line.startsWith("copy to ")) f.path = line.slice(8);
    else if (line.startsWith("index ")) {
      const m = line.match(/^index ([0-9a-f]+)\.\.([0-9a-f]+)/);
      if (m) { f.oldBlob = m[1]; f.blob = m[2]; }
    }
    else if (line.startsWith("Binary files ") || line === "GIT binary patch") f.binary = true;
    else if (line.startsWith("--- ")) { const p = line.slice(4); if (p !== "/dev/null" && !f.oldPath) f.oldPath = p.replace(/^a\//, ""); }
    else if (line.startsWith("+++ ")) { const p = line.slice(4); if (p !== "/dev/null") f.path = p.replace(/^b\//, ""); else f.path = f.oldPath ?? f.path; }
    else if (line.startsWith("@@ ")) {
      const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/);
      if (!m) continue;
      oldNo = +m[1]; newNo = +m[2];
      h = { header: m[3], lines: [] };
      f.hunks.push(h);
    } else if (h && (line.startsWith(" ") || line.startsWith("+") || line.startsWith("-"))) {
      const t = line[0] as DiffLine["t"];
      const dl: DiffLine = { t, text: line.slice(1) };
      if (t !== "+") dl.old = oldNo++;
      if (t !== "-") dl.new = newNo++;
      if (t === "+") f.adds++;
      if (t === "-") f.dels++;
      h.lines.push(dl);
    }
    // "\ No newline at end of file" and index lines: ignored
  }
  if (files.length !== identities.length)
    throw new Error(`git patch/name-status file count mismatch (${files.length} patch, ${identities.length} metadata)`);
  const seenPaths = new Set<string>();
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const identity = identities[i];
    // Patch markers are presentation syntax and may be absent (binary, empty,
    // or mode-only files). Re-assert the NUL-safe metadata after parsing.
    file.path = identity.path;
    file.oldPath = identity.oldPath ?? (identity.status === "add" ? undefined : identity.path);
    file.status = identity.status;
    if (!file.path) throw new Error(`git diff file ${i} has no path`);
    if (seenPaths.has(file.path))
      throw new Error(`git diff contains duplicate destination path "${file.path}"`);
    seenPaths.add(file.path);
    markIntraline(file);
    // deleted files have an all-zero "new" blob → identity is the old blob;
    // 100%-similarity renames have no index line → content is unchanged by definition
    if (!file.blob || /^0+$/.test(file.blob)) file.blob = file.oldBlob;
    file.blob ??= "same:" + (file.oldPath ?? file.path);
  }
  return files;
}

// char-level highlight for paired -/+ lines (common prefix/suffix trick)
function markIntraline(f: FileDiff) {
  for (const h of f.hunks) {
    let i = 0;
    while (i < h.lines.length) {
      if (h.lines[i].t !== "-") { i++; continue; }
      const dStart = i;
      while (i < h.lines.length && h.lines[i].t === "-") i++;
      const aStart = i;
      while (i < h.lines.length && h.lines[i].t === "+") i++;
      const pairs = Math.min(aStart - dStart, i - aStart);
      for (let k = 0; k < pairs; k++) {
        const d = h.lines[dStart + k], a = h.lines[aStart + k];
        let p = 0;
        while (p < d.text.length && p < a.text.length && d.text[p] === a.text[p]) p++;
        let s = 0;
        while (s < d.text.length - p && s < a.text.length - p &&
               d.text[d.text.length - 1 - s] === a.text[a.text.length - 1 - s]) s++;
        if (p + s === 0) continue; // nothing in common — whole line changed, no mark
        if (d.text.length - s > p) d.hl = [p, d.text.length - s];
        if (a.text.length - s > p) a.hl = [p, a.text.length - s];
      }
    }
  }
}

const diffs = new Map<string, { files: FileDiff[]; adds: number; dels: number; computeMs: number }>();
export async function diff(prId: number) {
  const b = await bundle(prId);
  const key = `${prId}:${b.iterationId}`;
  const hit = diffs.get(key);
  if (hit) return hit;
  const t0 = performance.now();
  const [raw, nameStatus] = await Promise.all([
    $`git -C ${b.repoDir} -c core.quotePath=false diff --no-color -U3 ${b.shas.base} ${b.shas.src}`.quiet().text(),
    $`git -C ${b.repoDir} diff --name-status -z ${b.shas.base} ${b.shas.src}`.quiet().text(),
  ]);
  const files = parseUnifiedDiff(raw, parseGitNameStatus(nameStatus));
  const out = {
    files,
    raw, // @pierre/diffs parses this client-side; our parse stays for blobs/crosscheck
    adds: files.reduce((s, f) => s + f.adds, 0),
    dels: files.reduce((s, f) => s + f.dels, 0),
    computeMs: Math.round(performance.now() - t0),
  };
  diffs.set(key, out);
  return out;
}

// ─────────────────────── file contents (context expansion) ───────────────────────
// Full old/new contents let @pierre/diffs expand unchanged context between
// hunks. Immutable per iteration, so cached forever.

const contentsCache = new Map<string, { name: string; contents: string | null }>();
export async function fileContents(prId: number, path: string, side: "old" | "new") {
  const b = await bundle(prId);
  const key = `${prId}:${b.iterationId}:${side}:${path}`;
  const hit = contentsCache.get(key);
  if (hit) return hit;
  const d = await diff(prId);
  const f = d.files.find((x) => x.path === path);
  if (!f) throw new HttpError(404, `${path} not in diff`);
  let out: { name: string; contents: string | null };
  if (f.binary || (side === "old" && f.status === "add") || (side === "new" && f.status === "delete")) {
    out = { name: path, contents: null };
  } else {
    const sha = side === "old" ? b.shas.base : b.shas.src;
    const p = side === "old" ? (f.oldPath ?? f.path) : f.path;
    const r = await $`git -C ${b.repoDir} show ${sha + ":" + p}`.quiet().nothrow();
    out = { name: p, contents: r.exitCode === 0 ? r.stdout.toString() : null };
  }
  contentsCache.set(key, out);
  return out;
}

// ─────────────────────────── highlighting ───────────────────────────
// Full-file tokenization (grammar state stays correct mid-file), then we ship
// only the lines the diff actually shows. Immutable per (iteration, path).

const THEME = "github-dark-default";
const EXT_LANG: Record<string, string> = {
  cs: "csharp", csx: "csharp", cshtml: "razor", razor: "razor",
  ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript",
  vue: "vue", json: "json", jsonc: "jsonc", yml: "yaml", yaml: "yaml",
  html: "html", htm: "html", css: "css", scss: "scss", less: "less",
  md: "markdown", sql: "sql", ps1: "powershell", psm1: "powershell",
  sh: "shellscript", bash: "shellscript", zsh: "shellscript",
  tf: "hcl", tfvars: "hcl", hcl: "hcl", toml: "toml", ini: "ini", editorconfig: "ini",
  xml: "xml", config: "xml", csproj: "xml", props: "xml", targets: "xml", nuspec: "xml", resx: "xml",
  py: "python", go: "go", rs: "rust", java: "java", kt: "kotlin", rb: "ruby", graphql: "graphql", proto: "proto",
};
function langFor(path: string): string | null {
  const base = path.split("/").pop() ?? "";
  if (/^dockerfile/i.test(base)) return "docker";
  return EXT_LANG[base.split(".").pop()?.toLowerCase() ?? ""] ?? null;
}

let hlPromise: Promise<Highlighter> | null = null;
const loadedLangs = new Set<string>();
async function highlighter(): Promise<Highlighter> {
  hlPromise ??= getSingletonHighlighter({ themes: [THEME], langs: [], engine: createOnigurumaEngine(import("shiki/wasm")) });
  return hlPromise;
}
const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function tokenizeFile(repoDir: string, sha: string, path: string, lang: string): Promise<string[] | null> {
  const r = await $`git -C ${repoDir} show ${sha + ":" + path}`.quiet().nothrow();
  if (r.exitCode !== 0) return null;
  const code = r.stdout.toString();
  if (code.length > 1_500_000) return null; // don't tokenize monsters; plain text is fine
  const hl = await highlighter();
  if (!loadedLangs.has(lang)) {
    try { await hl.loadLanguage(lang as any); loadedLangs.add(lang); }
    catch { return null; }
  }
  const { tokens } = hl.codeToTokens(code, { lang: lang as any, theme: THEME });
  return tokens.map((line) =>
    line.map((t) => (t.color ? `<span style="color:${t.color}">${escapeHtml(t.content)}</span>` : escapeHtml(t.content))).join(""));
}

const hlCache = new Map<string, { old: Record<number, string>; new: Record<number, string> }>();
export async function highlightFile(prId: number, path: string) {
  const b = await bundle(prId);
  const key = `${prId}:${b.iterationId}:${path}`;
  const hit = hlCache.get(key);
  if (hit) return hit;

  const d = await diff(prId);
  const f = d.files.find((x) => x.path === path);
  const empty = { old: {}, new: {} };
  if (!f || f.binary) return empty;
  const lang = langFor(f.path);
  if (!lang) return empty;

  const [newLines, oldLines] = await Promise.all([
    f.status === "delete" ? null : tokenizeFile(b.repoDir, b.shas.src, f.path, lang),
    f.status === "add" ? null : tokenizeFile(b.repoDir, b.shas.base, f.oldPath ?? f.path, lang),
  ]);

  const out = { old: {} as Record<number, string>, new: {} as Record<number, string> };
  for (const h of f.hunks) for (const l of h.lines) {
    if (l.t === "-" && oldLines?.[l.old! - 1] !== undefined) out.old[l.old!] = oldLines[l.old! - 1];
    else if (l.t !== "-" && newLines?.[l.new! - 1] !== undefined) out.new[l.new!] = newLines[l.new! - 1];
  }
  hlCache.set(key, out);
  return out;
}
