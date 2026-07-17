/* adoreview spike — keyboard-first PR review over the local data layer.
   Design: prefetch aggressively, render lazily, never block the first paint. */

"use strict";

// ───────────────────────── utils ─────────────────────────

const $app = document.getElementById("app");
const $hud = document.getElementById("hud");
const $help = document.getElementById("help");
const $banner = document.getElementById("banner");
const Keyboard = window.AdoreviewKeyboard;
if (!Keyboard) throw new Error("keyboard helpers failed to load");
const PLATFORM_KEYS = Keyboard.platformKeys();

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
const relTime = (iso) => {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 90) return "now";
  if (s < 5400) return `${Math.round(s / 60)}m`;
  if (s < 129600) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
};
const VOTE = {
  "10": ["✓", "v-approve", "approved"], "5": ["✓", "v-approve", "approved w/ suggestions"],
  "0": ["●", "v-none", "no vote"], "-5": ["⏸", "v-wait", "waiting for author"], "-10": ["✗", "v-reject", "rejected"],
};
function banner(msg) { $banner.classList.remove("update"); $banner.onclick = null; $banner.textContent = msg; $banner.hidden = !msg; }

async function fetchJson(url) {
  const t0 = performance.now();
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `${res.status} on ${url}`);
  return { data, ms: Math.round(performance.now() - t0), serverMs: +(res.headers.get("x-server-ms") || 0) };
}
async function postJson(url, body) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `${res.status} on ${url}`);
  return data;
}
async function patchJson(url, body) {
  const res = await fetch(url, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `${res.status} on ${url}`);
  return data;
}
// one open ⋯ menu at a time; any click elsewhere closes it (works from shadow
// DOM too — pointer events compose across the boundary)
let openPop = null;
document.addEventListener("click", () => { if (openPop) { openPop.hidden = true; openPop = null; } });

// ── remote diagnostics: mirror client errors into the server log ──
function shipLog(payload) {
  try { fetch("/api/log", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }); } catch {}
}
window.addEventListener("error", (e) =>
  shipLog({ kind: "error", message: String(e.message), source: `${e.filename}:${e.lineno}`, stack: e.error?.stack?.slice(0, 800) }));
window.addEventListener("unhandledrejection", (e) =>
  shipLog({ kind: "rejection", message: String(e.reason?.message ?? e.reason), stack: e.reason?.stack?.slice(0, 800) }));

// ───────────────────────── state ─────────────────────────

// Styles for things WE render inside @pierre/diffs' shadow root (thread cards,
// composer, gutter 💬). Injected into the page head too (overview + legacy
// fallback use the same classes in light DOM). CSS custom properties inherit
// across the shadow boundary, so var(--*) tokens keep working.
const ANNOTATION_CSS = `
.thread { margin: .45rem .9rem .6rem 4.2em; border: 1px solid var(--border); border-radius: 8px;
  background: var(--bg); font-family: var(--sans); max-width: 760px; }
.thread.flash { outline: 2px solid var(--accent); outline-offset: 1px; }
.thread .th { display: flex; gap: .5rem; align-items: center; padding: .35rem .7rem;
  border-bottom: 1px solid var(--border); font-size: 11px; color: var(--dim); }
.pill { font: 10px var(--mono); padding: 0 .45em; border-radius: 8px; border: 1px solid; }
.pill.active { color: var(--amber); border-color: var(--amber); }
.pill.fixed, .pill.closed { color: var(--green); border-color: var(--green); opacity: .8; }
.pill.wontFix, .pill.unknown, .pill.pending { color: var(--dim); border-color: var(--border); }
.comment { padding: .5rem .7rem; border-bottom: 1px solid var(--border); }
.comment:last-child { border-bottom: 0; }
.comment .who { font-size: 11.5px; margin-bottom: .15rem; }
.comment .who b { color: var(--text); }
.comment .who span { color: var(--dim); margin-left: .5em; }
.th .sp { flex: 1; }
.tact { color: var(--dim); font-size: 10.5px; cursor: pointer; font-family: var(--mono); }
.tact:hover { color: var(--accent); }
.cmenu { float: right; position: relative; }
.cdots { color: var(--dim); cursor: pointer; padding: 0 .35em; font-size: 14px; line-height: 1; }
.cdots:hover { color: var(--text); }
.cpop { position: absolute; right: 0; top: 1.3em; z-index: 30; background: var(--panel);
  border: 1px solid var(--border); border-radius: 8px; min-width: 140px; overflow: hidden;
  box-shadow: 0 10px 28px rgba(0,0,0,.45); }
.citem { padding: .45rem .8rem; font-size: 12px; cursor: pointer; color: var(--text);
  font-family: var(--sans); white-space: nowrap; }
.citem:hover { background: var(--panel2); }
.citem.danger { color: var(--red); }
.editbox { border: 1px solid var(--border); border-radius: 8px; margin: .3rem 0; background: var(--bg); }
.editbox:focus-within { border-color: var(--accent); }
.editbox textarea { display: block; width: 100%; min-height: 64px; resize: vertical;
  background: transparent; border: 0; outline: none; color: var(--text);
  font: 13px/1.5 var(--sans); padding: .6rem .7rem; box-sizing: border-box; }
.comment .body.md { font-size: 12.5px; }
.md { font-size: 13.5px; line-height: 1.65; color: var(--text); }
.md p { margin: .35rem 0; }
.md code { font: 11.5px var(--mono); background: var(--panel2); border: 1px solid var(--border);
  border-radius: 5px; padding: .06em .4em; }
.md pre { font: 11.5px/1.55 var(--mono); background: var(--panel2); border: 1px solid var(--border);
  border-radius: 8px; padding: .7rem .9rem; overflow-x: auto; margin: .5rem 0; }
.md ul, .md ol { padding-left: 1.4rem; margin: .35rem 0; }
.md li { margin: .2rem 0; }
.md h3, .md h4, .md h5, .md h6 { margin: .9rem 0 .35rem; font-size: 14.5px; font-weight: 650; }
.md h4 { font-size: 13.5px; } .md h5, .md h6 { font-size: 12.5px; }
.md a { color: var(--accent); text-decoration: none; }
.md a:hover { text-decoration: underline; }
.md blockquote { border-left: 3px solid var(--border); padding-left: .8rem; color: var(--dim); margin: .4rem 0; }
.md .nodesc { color: var(--dim); font-style: italic; }
.replyin { display: block; width: calc(100% - 1.4rem); margin: .5rem .7rem .6rem;
  background: var(--panel2); border: 1px solid var(--border); border-radius: 8px;
  min-height: 36px; max-height: 160px; resize: vertical; box-sizing: border-box;
  padding: .42rem .65rem; color: var(--text); font: 12.5px/1.45 var(--sans); outline: none; }
.replyin:focus { border-color: var(--accent); }
.composer { margin: .5rem .95rem .7rem 4.2em; max-width: 760px; background: var(--bg);
  border: 1px solid var(--border); border-radius: 10px; font-family: var(--sans); }
.composer:focus-within { border-color: var(--accent); }
.composer textarea { display: block; width: 100%; min-height: 74px; resize: vertical;
  background: transparent; border: 0; outline: none; color: var(--text);
  font: 13px/1.5 var(--sans); padding: .7rem .8rem; box-sizing: border-box; }
.cfoot { display: flex; align-items: center; justify-content: space-between;
  padding: .4rem .6rem; border-top: 1px solid var(--border); }
.cfoot .hint { color: var(--dim); font-size: 11px; font-family: var(--mono); }
.csend { background: var(--accent); color: #04121f; border: 0; border-radius: 6px;
  padding: .32rem .8rem; font: 600 12px var(--sans); cursor: pointer; }
.csend:disabled { opacity: .6; cursor: default; }
/* gutter comment affordance: the library's own [data-utility-button] — its
   stylesheet owns positioning; we only wire onGutterUtilityClick */
/* custom file header (rendered into the shadow root — style everything here) */
.phead { display: flex; align-items: center; gap: .55rem; padding: .55rem .95rem; width: 100%;
  box-sizing: border-box; font-family: var(--sans); font-size: 13px; cursor: pointer; min-width: 0; }
.phead .st { flex: none; font: 700 12px var(--mono); width: 1em; text-align: center; }
.ficon { flex: none; min-width: 26px; height: 16px; padding: 0 5px; border-radius: 4px;
  display: inline-flex; align-items: center; justify-content: center;
  font: 700 9px var(--mono); letter-spacing: .03em; color: var(--chipc, var(--dim));
  background: color-mix(in srgb, var(--chipc, var(--dim)) 16%, transparent);
  border: 1px solid color-mix(in srgb, var(--chipc, var(--dim)) 38%, transparent);
  box-sizing: border-box; }
.ficon.has-img { background: transparent; border-color: transparent; padding: 0; min-width: 18px; }
.fimg { width: 16px; height: 16px; display: block; }
/* the icon morphs into a collapse chevron on hover AND while collapsed */
.ficon .fchv { display: none; color: var(--dim); font-size: 12px;
  transition: transform .15s ease; }
.phead:hover .ficon :is(.flbl, .fimg),
.phead.is-collapsed .ficon :is(.flbl, .fimg) { display: none; }
.phead:hover .ficon .fchv,
.phead.is-collapsed .ficon .fchv { display: inline; }
.phead.is-collapsed .ficon .fchv { transform: rotate(-90deg); }
.phead:hover .ficon { background: transparent; border-color: transparent; }
.st-add { color: var(--green); } .st-delete { color: var(--red); }
.st-rename { color: var(--accent); } .st-edit { color: var(--amber); }
.phead .chev { flex: none; color: var(--dim); font-size: 10px; width: .9em; }
.phead .pname { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.phead .pname b { font-weight: 600; color: var(--text); }
.phead .pname .dir { color: var(--dim); font-size: 11.5px; margin-left: .4em; }
.phead .sp { flex: 1; }
.phead .pstats { flex: none; font: 11.5px var(--mono); }
.phead .pstats .a { color: var(--green); }
.phead .pstats .d { color: var(--red); }
.tag { font: 10px var(--mono); border: 1px solid var(--border); color: var(--dim);
  border-radius: 4px; padding: 0 .35em; flex: none; }
.tag.amber, .tag.draft { color: var(--amber); border-color: var(--amber); }
.revcb { flex: none; width: 15px; height: 15px; border: 1.5px solid var(--border);
  border-radius: 4px; display: inline-flex; align-items: center; justify-content: center;
  font-size: 10px; color: transparent; cursor: pointer; }
.revcb:hover { border-color: var(--green); }
.revcb.on { background: var(--green); border-color: var(--green); color: #04140a; }
.cbubble { position: absolute; left: 5px; width: 22px; height: 22px; border-radius: 50%;
  background: var(--panel2); border: 1px solid var(--border); display: flex; align-items: center;
  justify-content: center; font-size: 11px; cursor: pointer; z-index: 4; }
.cbubble:hover { border-color: var(--accent); }
`;
document.head.append(Object.assign(document.createElement("style"), { textContent: ANNOTATION_CSS }));

const state = {
  view: "inbox", me: null, prs: [],
  rows: [], sel: 0, filter: "", scope: "mine", // mine = authored or reviewing
  cache: new Map(), inflight: new Map(),   // prId → {bundle, diff, reviewed, ms} | Promise
  pr: null, files: [], fileIdx: 0,
  threadAnchors: [], threadIdx: -1,
  inboxScroll: 0,
  hud: {},
  diffStyle: localStorage.getItem("adoreview:diffstyle") || "unified", // 'unified' (stacked) | 'split'
  // CodeView-mode state (per open PR)
  codeView: null, workerPool: undefined,
  itemVersion: new Map(), cvCollapsed: new Set(), drafts: new Map(), pierreMeta: new Map(),
  diffSession: null,
  // live refresh (poll open PR for others' activity; ADO has no ETag on threads)
  pulseTimer: null, pulseStamp: null,
};

const POLL_MS = 30_000;

function stopPulse() {
  if (state.pulseTimer) { clearInterval(state.pulseTimer); state.pulseTimer = null; }
  state.pulseStamp = null;
}
// (re)start polling for the currently-open PR; first tick establishes the
// baseline so we never flag the state that was already on screen
function startPulse() {
  stopPulse();
  state.pulseTimer = setInterval(pulseCheck, POLL_MS);
}
async function pulseCheck() {
  if (document.hidden) return;                       // never poll a backgrounded tab
  const entry = state.pr;
  if (!entry || (state.view !== "diff" && state.view !== "overview")) return;
  const id = entry.bundle.pr.id;
  try {
    const { data } = await fetchJson(`/api/pr/${id}/pulse`);
    if (state.pr?.bundle.pr.id !== id) return;       // navigated away mid-request
    if (state.pulseStamp === null) { state.pulseStamp = data.stamp; return; } // baseline
    if (data.stamp !== state.pulseStamp) {
      state.pulseStamp = data.stamp;
      showUpdateBanner();
    }
  } catch { /* transient — next tick retries */ }
}
// non-destructive: a click/`r` reloads, so an in-progress read or draft is never
// yanked out from under the reviewer
function showUpdateBanner() {
  $banner.classList.remove("update");
  $banner.textContent = "PR updated on Azure DevOps · press r or click to reload";
  $banner.classList.add("update");
  $banner.onclick = () => { banner(""); refreshPr(curView()); };
  $banner.hidden = false;
}

// refetch just the inbox list (focus refresh; lighter than a full boot)
async function refreshInbox() {
  try { const prs = await fetchJson("/api/prs"); state.prs = prs.data; renderList(); } catch {}
}

// window focus / tab back to foreground → refresh appropriately, immediately
function onForeground() {
  if (state.view === "inbox") refreshInbox();
  else if (state.view === "diff" || state.view === "overview") pulseCheck();
}
window.addEventListener("focus", onForeground);
document.addEventListener("visibilitychange", () => { if (!document.hidden) onForeground(); });

function rememberDiffSession() {
  if (state.view !== "diff" || !state.pr) return;
  state.diffSession = {
    prId: state.pr.bundle.pr.id,
    iterationId: state.pr.bundle.iterations.latestId,
    fileIdx: state.fileIdx,
    collapsed: [...state.cvCollapsed],
    filter: document.querySelector(".sfilter")?.value ?? "",
  };
}

function dropCodeView() {
  try { state.codeView?.cleanUp(); } catch {}
  state.codeView = null;
}

function setDiffStyle(v) {
  if (state.diffStyle === v) return;
  state.diffStyle = v;
  localStorage.setItem("adoreview:diffstyle", v);
  document.querySelectorAll(".layout-toggle [data-diff-style]").forEach((tab) =>
    tab.classList.toggle("active", tab.dataset.diffStyle === v));
  if (!state.pr || state.view !== "diff") return;
  if (state.codeView) {
    state.codeView.setOptions(cvOptions());
    state.codeView.render(true);
    setTimeout(cvSyncCollapsedAttrs, 0);
    return;
  }
  rememberDiffSession();
  renderDiff(state.pr);
}
function layoutToggle() {
  const wrap = el("span", "tabs layout-toggle");
  for (const [val, label] of [["unified", "Stacked"], ["split", "Split"]]) {
    const b = el("span", "tab" + (state.diffStyle === val ? " active" : ""), label);
    b.dataset.diffStyle = val;
    b.onclick = () => setDiffStyle(val);
    wrap.append(b);
  }
  return wrap;
}

function loadPr(id) {
  if (state.cache.has(id)) return Promise.resolve(state.cache.get(id));
  if (state.inflight.has(id)) return state.inflight.get(id);
  const p = Promise.all([fetchJson(`/api/pr/${id}`), fetchJson(`/api/pr/${id}/diff`), fetchJson(`/api/pr/${id}/reviewed`)])
    .then(([b, d, r]) => {
      const entry = { bundle: b.data, diff: d.data, reviewed: r.data, ms: b.ms + d.ms };
      state.cache.set(id, entry);
      state.inflight.delete(id);
      markDot(id);
      return entry;
    })
    .catch((e) => { state.inflight.delete(id); throw e; });
  state.inflight.set(id, p);
  return p;
}

// reviewed is keyed by content: a stored blob that no longer matches means the
// file changed after you reviewed it — the checkbox "breaks" on purpose
const isReviewed = (f) => state.pr?.reviewed?.[f.path] === f.blob;
const changedSinceReview = (f) => {
  const b = state.pr?.reviewed?.[f.path];
  return !!b && b !== f.blob;
};

// ───────────────────────── inbox ─────────────────────────

function groupPrs() {
  const me = state.me, f = state.filter.toLowerCase();
  const match = (pr) => !f ||
    `${pr.id} ${pr.title} ${pr.repo.name} ${pr.author.name} ${pr.source}`.toLowerCase().includes(f);
  const attached = (pr) => pr.author.id === me.id || pr.reviewers.some((r) => !r.group && r.id === me.id);
  const matched = state.prs.filter(match);
  const prs = state.scope === "mine" ? matched.filter(attached) : matched;
  const needs = [], mine = [], rest = [];
  for (const pr of prs) {
    const myReview = pr.reviewers.find((r) => !r.group && r.id === me.id);
    if (pr.author.id === me.id) mine.push(pr);
    else if (myReview && myReview.vote === 0 && !pr.isDraft) needs.push(pr);
    else rest.push(pr);
  }
  return {
    groups: [["Needs your review", needs], ["Yours", mine],
      [state.scope === "mine" ? "Reviewing" : "Everything else", rest]],
    hidden: matched.length - prs.length,
  };
}

function voteSummary(pr) {
  const seen = pr.reviewers.filter((r) => !r.group && r.vote !== 0);
  const wrap = el("span", "votes");
  for (const r of seen.slice(0, 5)) {
    const [icon, cls, label] = VOTE[String(r.vote)] ?? VOTE["0"];
    const s = el("span", cls, icon);
    s.title = `${r.name}: ${label}`;
    wrap.append(s, " ");
  }
  const pending = pr.reviewers.filter((r) => !r.group && r.required && r.vote === 0).length;
  if (pending) wrap.append(Object.assign(el("span", "v-none", `·${pending}`), { title: `${pending} required reviewer(s) pending` }));
  return wrap;
}

function renderInbox() {
  dropCodeView();
  stopPulse();
  state.view = "inbox";
  document.title = "review";
  location.hash = "";
  $app.replaceChildren();

  const bar = el("div", "topbar");
  const logo = el("span", "logo"); logo.innerHTML = "<em>ado</em>review";
  const input = el("input"); input.id = "filter"; input.placeholder = "/ filter"; input.value = state.filter;
  input.oninput = () => { state.filter = input.value; renderList(); };
  input.onkeydown = (e) => handleFilterKey(e, input, () => {
    const pr = selectedPr();
    if (pr) openPr(pr.id);
  });
  bar.append(logo, el("span", "hint", `${state.me.name} · ${state.me.org}/${state.me.project}`), el("span", "spacer"), input,
    hintKbd("j/k", "move"), hintKbd("⏎", "open"), hintKbd("?", "help"));
  $app.append(bar);

  const box = el("div", "inbox"); box.id = "inboxlist";
  $app.append(box);
  renderList();
  window.scrollTo(0, state.inboxScroll);
}

function hintKbd(k, label) {
  const s = el("span", "hint");
  const kb = el("kbd", "", k);
  s.append(kb, ` ${label}`);
  return s;
}

function handleFilterKey(e, input, onEnter) {
  if (e.isComposing) return;
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    input.value = "";
    input.dispatchEvent(new Event("input"));
    input.blur();
  } else if (e.key === "Enter") {
    e.preventDefault();
    e.stopPropagation();
    input.blur();
    onEnter();
  }
}

function handleCommentEditorKey(e, onEscape, onSubmit) {
  e.stopPropagation();
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === "Escape") {
    e.preventDefault();
    onEscape();
  } else if (e.key === "Enter" && e.repeat && !e.shiftKey) {
    // The initial keydown already submitted synchronously. Suppress repeats so
    // they cannot queue another request or add stray newlines while loading.
    e.preventDefault();
  } else if (Keyboard.isSubmitShortcut(e)) {
    e.preventDefault();
    onSubmit();
  }
}

function renderList() {
  const box = document.getElementById("inboxlist");
  if (!box) return;
  box.replaceChildren();
  state.rows = [];
  const { groups, hidden } = groupPrs();
  const scopeline = el("div", "scopeline");
  const toggle = el("span", "scopetoggle",
    state.scope === "mine" ? `showing PRs attached to you · ${hidden} hidden` : "showing all PRs");
  toggle.append(Object.assign(el("kbd", "", "a"), { style: "margin-left:.5em" }));
  toggle.onclick = () => { state.scope = state.scope === "mine" ? "all" : "mine"; renderList(); prefetch(); };
  scopeline.append(toggle);
  box.append(scopeline);
  for (const [name, prs] of groups) {
    if (!prs.length) continue;
    const h = el("div", "section-h"); h.innerHTML = `${name} <b>${prs.length}</b>`;
    const list = el("div", "rows");
    for (const pr of prs) {
      const row = el("div", "row" + (pr.local ? "" : " nolocal"));
      row.dataset.id = pr.id;
      const dot = el("span", "dot" + (state.cache.has(pr.id) ? " ready" : ""));
      dot.title = "prefetched";
      row.append(dot, el("span", "chip", pr.repo.name), el("span", "id", `!${pr.id}`));
      const title = el("span", "title", pr.title);
      title.title = pr.title;
      row.append(title);
      if (pr.isDraft) row.append(el("span", "tag draft", "draft"));
      if (!pr.local) row.append(el("span", "tag", "no clone"));
      row.append(el("span", "meta", `${pr.author.name.split(" ")[0]} · ${relTime(pr.created)}`), voteSummary(pr));
      row.onclick = () => { state.sel = state.rows.indexOf(row); paintSel(); openPr(pr.id); };
      list.append(row);
      state.rows.push(row);
    }
    box.append(h, list);
  }
  if (!state.rows.length) box.append(el("div", "empty", state.filter ? "nothing matches" : "no active PRs 🎉"));
  state.sel = Math.min(state.sel, Math.max(0, state.rows.length - 1));
  paintSel(false);
}

function paintSel(scroll = true) {
  state.rows.forEach((r, i) => r.classList.toggle("sel", i === state.sel));
  if (scroll) state.rows[state.sel]?.scrollIntoView({ block: "nearest" });
}
function markDot(id) {
  document.querySelector(`.row[data-id="${id}"] .dot`)?.classList.add("ready");
}

// prefetch: needs-review first, then mine, then the rest — 2 workers
async function prefetch() {
  const ids = groupPrs().groups.flatMap(([, prs]) => prs).filter((p) => p.local).map((p) => p.id).slice(0, 14);
  const queue = [...ids];
  const worker = async () => {
    while (queue.length) {
      const id = queue.shift();
      if (state.cache.has(id)) continue;
      await loadPr(id).catch(() => {});
    }
  };
  await Promise.all([worker(), worker()]);
}

// ───────────────────────── PR view ─────────────────────────

async function openPr(id, sub = "overview") {
  const pr = state.prs.find((p) => p.id === id);
  if (pr && !pr.local) { banner(`!${id}: no local clone of ${pr.repo.name} — press o to open in ADO`); setTimeout(() => banner(""), 3000); return; }
  state.inboxScroll = window.scrollY;
  const t0 = performance.now();
  const cached = state.cache.has(id);
  let entry;
  try {
    if (!cached) $app.replaceChildren(el("div", "boot", `loading !${id}…`));
    entry = await loadPr(id);
  } catch (e) { banner(e.message); setTimeout(() => banner(""), 4000); if (!cached) renderInbox(); return; }
  const fetchMs = Math.round(performance.now() - t0);
  const r0 = performance.now();
  renderPrView(entry, sub);
  state.hud = { src: cached ? "prefetched ✦" : `api ${fetchMs}ms`, diff: `${entry.diff.computeMs}ms`,
    render: `${Math.round(performance.now() - r0)}ms`, hlDone: 0, hlTotal: 0 };
  paintHud();
}

function paintHud() {
  const h = state.hud;
  if (state.view !== "diff") { $hud.hidden = true; return; }
  $hud.hidden = false;
  $hud.innerHTML = `open <b>${h.src}</b> · diff(server) <b>${h.diff}</b> · paint <b>${h.render}</b>` +
    (h.hlTotal ? ` · syntax <b>${h.hlDone}/${h.hlTotal}</b>` : "");
}

function renderPrView(entry, sub) {
  if (state.pr === entry && state.view === sub) return;
  if (state.view === "diff") rememberDiffSession();
  sub === "diff" ? renderDiff(entry) : renderOverview(entry);
  paintHud();
}

// shared PR topbar with Overview | Diff tabs
function prTopbar(entry, active, extras = null) {
  const { pr } = entry.bundle;
  const bar = el("div", "topbar");
  const back = el("span", "hint"); back.append(el("kbd", "", "esc"), " inbox");
  back.style.cursor = "pointer"; back.onclick = () => renderInbox();
  const tabs = el("span", "tabs");
  for (const [key, label, kb] of [["overview", "Overview", "1"], ["diff", "Diff", "2"]]) {
    const t = el("span", "tab" + (active === key ? " active" : ""));
    t.append(label, el("kbd", "", kb));
    t.onclick = () => renderPrView(entry, key);
    tabs.append(t);
  }
  bar.append(back, el("span", "logo", `!${pr.id}`), el("span", "chip", pr.repo.name), tabs);
  if (extras) bar.append(...extras);
  else bar.append(el("span", "spacer"), hintKbd("1/2", "tabs"), hintKbd("⏎", "diff"), hintKbd("o", "ado"), hintKbd("?", "help"));
  return bar;
}

// ── Overview (description · activity · meta sidebar) ──

function renderOverview(entry) {
  dropCodeView();
  state.view = "overview";
  startPulse();
  const { pr } = entry.bundle;
  state.pr = entry;
  state.files = entry.diff.files;
  document.title = `!${pr.id} ${pr.title}`;
  location.hash = `pr/${pr.id}`;
  $app.replaceChildren();
  $app.append(prTopbar(entry, "overview"));

  const wrap = el("div", "ovwrap");
  const main = el("div", "ovmain");
  const aside = el("div", "ovside");
  wrap.append(main, aside);
  $app.append(wrap);

  main.append(el("h1", "ovtitle", pr.title));
  const by = el("div", "ovby");
  const branches = el("span");
  branches.append(el("span", "branch", pr.target), " ← ", el("span", "branch", pr.source));
  by.append(el("span", "", pr.author.name), branches, el("span", "", `${relTime(pr.created)} ago`),
    el("span", "", `${entry.bundle.iterations.count} push${entry.bundle.iterations.count > 1 ? "es" : ""}`));
  main.append(by);

  main.append(el("h3", "ovh", "Description"));
  const desc = el("div", "md");
  desc.innerHTML = pr.description ? md(pr.description) : `<p class="nodesc">no description</p>`;
  main.append(desc);

  main.append(el("h3", "ovh", "Activity"));
  const act = el("div", "ovact");
  for (const ev of buildEvents(entry)) {
    const row = el("div", "ovevent");
    row.append(el("span", "dot2"), el("span", "t", ev.text), el("span", "when", `${relTime(ev.date)} ago`));
    act.append(row);
  }
  main.append(act);

  if (entry.bundle.threads.prLevel.length) {
    main.append(el("h3", "ovh", "Discussion"));
    for (const t of entry.bundle.threads.prLevel) main.append(threadCard(t));
  }

  // ── meta sidebar
  aside.append(sideCard("Status", [statusRow(pr)]));
  const people = pr.reviewers.filter((r) => !r.group);
  if (people.length) aside.append(sideCard("Reviewers", people.map((r) => {
    const [icon, cls, label] = VOTE[String(r.vote)] ?? VOTE["0"];
    const row = el("div", "srow");
    row.title = `${r.name}: ${label}`;
    row.append(el("span", cls, icon), el("span", "t", r.name));
    if (r.required) row.append(el("span", "tag", "required"));
    return row;
  })));
  const wis = entry.bundle.workItems ?? [];
  if (wis.length) aside.append(sideCard("Work items", wis.map((w) => {
    const row = el("div", "srow link");
    row.onclick = () => window.open(w.url);
    row.title = `${w.type} ${w.id}: ${w.title}`;
    row.append(el("span", "id", `#${w.id}`), el("span", "t", w.title), el("span", "tag", w.state));
    return row;
  })));
  const files = entry.diff.files;
  const byChurn = files.map((f, i) => ({ f, i })).sort((a, b) => (b.f.adds + b.f.dels) - (a.f.adds + a.f.dels));
  const frows = byChurn.slice(0, 8).map(({ f, i }) => {
    const row = el("div", "srow link");
    row.onclick = () => { renderDiff(entry); jumpFile(i); };
    const base = f.path.split("/").pop();
    const fn = el("span", "t fn2");
    fn.append(el("b", "", base), el("span", "dir", " " + f.path.slice(0, f.path.length - base.length)));
    fn.title = f.path;
    row.append(fn, el("span", f.adds >= f.dels ? "v-approve" : "v-reject", f.adds >= f.dels ? `+${f.adds}` : `−${f.dels}`));
    return row;
  });
  if (files.length > 8) {
    const more = el("div", "srow link dim", `↓ ${files.length - 8} more files`);
    more.onclick = () => renderDiff(entry);
    frows.push(more);
  }
  aside.append(sideCard(`${files.length} files changed · +${entry.diff.adds} −${entry.diff.dels}`, frows));
}

function statusRow(pr) {
  const row = el("div", "srow");
  const open = pr.status === "active";
  row.append(el("span", open ? "v-approve" : "v-none", open ? "●" : "○"),
    el("span", "t", pr.isDraft ? "Open (draft)" : open ? "Open" : pr.status));
  if (pr.mergeStatus && pr.mergeStatus !== "succeeded") row.append(el("span", "tag draft", pr.mergeStatus));
  return row;
}
function sideCard(title, rows) {
  const c = el("div", "scard");
  c.append(el("div", "sh", title));
  for (const r of rows) c.append(r);
  return c;
}
function buildEvents(entry) {
  const { pr } = entry.bundle;
  const evs = [{ date: pr.created, text: `${pr.author.name} opened this PR` }];
  for (const it of (entry.bundle.iterations.list ?? []).slice(1))
    evs.push({ date: it.created, text: `${it.author || pr.author.name} pushed update #${it.id}` });
  for (const ev of entry.bundle.events ?? []) evs.push(ev);
  return evs.sort((a, b) => Date.parse(a.date) - Date.parse(b.date)).slice(-25);
}

// minimal markdown → safe HTML (escape first, then transform)
function md(src) {
  const inline = (s) => escText(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/\*([^*\s][^*]*)\*/g, "<i>$1</i>")
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
    .replace(/(^|\s)(https?:\/\/[^\s<]+)/g, '$1<a href="$2" target="_blank" rel="noreferrer">$2</a>');
  let html = "", inCode = false, list = 0; // 0 none · 1 ul · 2 ol
  const closeList = () => { if (list) { html += list === 1 ? "</ul>" : "</ol>"; list = 0; } };
  for (const raw of String(src).replace(/\r\n/g, "\n").split("\n")) {
    if (raw.startsWith("```")) { closeList(); inCode = !inCode; html += inCode ? "<pre>" : "</pre>"; continue; }
    if (inCode) { html += escText(raw) + "\n"; continue; }
    const h = raw.match(/^(#{1,4})\s+(.*)/);
    if (h) { closeList(); const lvl = h[1].length + 2; html += `<h${lvl}>${inline(h[2])}</h${lvl}>`; continue; }
    const ul = raw.match(/^\s*[-*+]\s+(.*)/);
    if (ul) { if (list !== 1) { closeList(); html += "<ul>"; list = 1; } html += `<li>${inline(ul[1])}</li>`; continue; }
    const ol = raw.match(/^\s*\d+[.)]\s+(.*)/);
    if (ol) { if (list !== 2) { closeList(); html += "<ol>"; list = 2; } html += `<li>${inline(ol[1])}</li>`; continue; }
    closeList();
    if (/^\s*>\s?/.test(raw)) { html += `<blockquote>${inline(raw.replace(/^\s*>\s?/, ""))}</blockquote>`; continue; }
    html += raw.trim() ? `<p>${inline(raw)}</p>` : "";
  }
  if (inCode) html += "</pre>";
  closeList();
  return html;
}

// ── Diff view ──

function renderDiff(entry) {
  dropCodeView();
  state.view = "diff";
  startPulse();
  const { pr } = entry.bundle;
  const diff = entry.diff;
  const session = state.diffSession?.prId === pr.id &&
    state.diffSession?.iterationId === entry.bundle.iterations.latestId ? state.diffSession : null;
  state.pr = entry;
  state.files = diff.files;
  state.fileIdx = Math.max(0, Math.min(session?.fileIdx ?? 0, Math.max(0, diff.files.length - 1)));
  state.threadAnchors = [];
  state.threadIdx = -1;
  state.itemVersion = new Map();
  state.drafts = new Map();
  state.pierreMeta = new Map();
  state.cvSel = null;
  // parse the raw patch once with @pierre/diffs (same git output our parser
  // read, so file order matches state.files by index)
  state.pierreFiles = null;
  state.pierreRaw = null;
  if (window.Pierre && diff.raw) {
    try {
      const cachePrefix = `pr${pr.id}i${entry.bundle.iterations.latestId}`;
      state.pierreFiles = window.Pierre.processPatch(diff.raw, cachePrefix).files;
      // per-file raw chunks (same order) — lets us re-parse one file WITH
      // full contents attached so hunk expansion works without recomputing
      state.pierreRaw = diff.raw.split(/^(?=diff --git )/m).filter((c) => c.startsWith("diff --git "));
    } catch (e) { console.warn("pierre parse failed — legacy renderer", e); }
  }
  // Restore the reviewer's working set when returning from Overview. On a new
  // PR/iteration, reviewed + generated files start collapsed.
  const paths = new Set(state.files.map((f) => f.path));
  state.cvCollapsed = session
    ? new Set(session.collapsed.filter((path) => paths.has(path)))
    : new Set(state.files.filter((f) => isReviewed(f) || isGenerated(f)).map((f) => f.path));
  document.title = `!${pr.id} ${pr.title}`;
  location.hash = `pr/${pr.id}/diff`;
  $app.replaceChildren();

  // ── header
  const prog = el("span", "hint"); prog.id = "revprog";
  $app.append(prTopbar(entry, "diff", [prog, el("span", "spacer"), layoutToggle(),
    hintKbd("j/k", "files"), hintKbd("v", "reviewed"), hintKbd("n/p", "threads"), hintKbd("?", "help")]));

  const head = el("div", "prhead");
  const t1 = el("div", "t1");
  t1.append(el("h1", "", pr.title));
  if (pr.isDraft) t1.append(el("span", "tag draft", "draft"));
  const t2 = el("div", "t2");
  const branches = el("span");
  branches.append(el("span", "branch", pr.source), " → ", el("span", "branch", pr.target));
  t2.append(branches,
    el("span", "", `${pr.author.name} · ${relTime(pr.created)} ago`),
    el("span", "", `${entry.bundle.iterations.count} push${entry.bundle.iterations.count > 1 ? "es" : ""}`),
    el("span", "", `${diff.files.length} files `));
  const pm = el("span"); pm.innerHTML = `<span class="v-approve">+${diff.adds}</span> <span class="v-reject">−${diff.dels}</span>`;
  t2.append(pm);
  if (pr.mergeStatus && pr.mergeStatus !== "succeeded") t2.append(el("span", "v-reject", `merge: ${pr.mergeStatus}`));
  for (const r of pr.reviewers.filter((x) => !x.group)) {
    const [icon, cls, label] = VOTE[String(r.vote)] ?? VOTE["0"];
    const rv = el("span", "reviewer");
    rv.append(el("span", cls, icon), r.name.split(" ")[0]);
    rv.title = `${r.name}: ${label}${r.required ? " (required)" : ""}`;
    t2.append(rv);
  }
  head.append(t1, t2);
  $app.append(head); // description + PR-level discussion live on the Overview tab

  // ── body: sidebar + diff
  const body = el("div", "prbody");
  const side = el("div", "sidebar");
  const main = el("div", "main");
  body.append(side, main);
  $app.append(body);

  const threadsByPath = new Map();
  for (const t of entry.bundle.threads.file) {
    if (!threadsByPath.has(t.path)) threadsByPath.set(t.path, []);
    threadsByPath.get(t.path).push(t);
  }

  // sidebar file filter ("Filter files…")
  const sfilter = el("input", "sfilter");
  sfilter.placeholder = "filter files…";
  sfilter.value = session?.filter ?? "";
  const applyFileFilter = () => {
    const q = sfilter.value.toLowerCase();
    document.querySelectorAll(".sfile").forEach((s) =>
      (s.hidden = !!q && !state.files[+s.dataset.i].path.toLowerCase().includes(q)));
  };
  sfilter.oninput = applyFileFilter;
  sfilter.onkeydown = (e) => handleFilterKey(e, sfilter, () => {
    const first = document.querySelector(".sfile:not([hidden])");
    if (first) jumpFile(+first.dataset.i);
  });
  side.append(sfilter);

  diff.files.forEach((f, i) => side.append(sideRow(f, i)));
  applyFileFilter();
  // register thread anchors (els attach when their file renders)
  diff.files.forEach((f, i) => {
    for (const t of (threadsByPath.get(f.path) ?? [])) state.threadAnchors.push({ fileIdx: i, thread: t, el: null });
  });
  state.threadsByPath = threadsByPath;
  paintProgress();

  // ── CodeView path: one flowing virtualized document, library-owned headers
  if (state.pierreFiles) {
    const root = el("div", "cvroot");
    try {
      body.classList.add("fixed");
      // fit to the viewport below our chrome BEFORE setup — CodeView measures
      // its root's height; a 0-height root renders nothing
      body.style.height = `calc(100vh - ${body.offsetTop}px)`;
      main.append(root);
      const view = new window.Pierre.CodeView(cvOptions(), state.workerPool);
      state.codeView = view;
      view.setup(root);
      view.setItems(state.files.map((f) => cvItem(f)));
      view.render(true);
      view.subscribeToScroll(cvOnScroll);
      // click a collapsed file row to expand it (checkbox clicks stopPropagation)
      root.addEventListener("click", (e) => {
        const host = e.composedPath().find((n) => n.tagName === "DIFFS-CONTAINER");
        if (!host || !state.codeView) return;
        const rendered = state.codeView.getRenderedItems().find((r) => r.element === host);
        const f = rendered && fileByPath(rendered.item.id);
        if (f && state.cvCollapsed.has(f.path)) cvToggleCollapse(f);
      });
      setTimeout(cvLoadVisibleContents, 80);
      setTimeout(cvSyncCollapsedAttrs, 50);
      // diagnostic snapshot → server log (remove once stable)
      setTimeout(() => shipLog({
        kind: "cv-snapshot",
        rootH: root.clientHeight, rootScrollH: root.scrollHeight,
        bodyH: body.clientHeight, bodyTop: body.offsetTop,
        viewScrollH: view.getScrollHeight?.(), viewH: view.getHeight?.(),
        rendered: view.getRenderedItems?.().length, items: state.files.length,
        rootChildren: root.children.length,
        containerHTML: root.innerHTML.slice(0, 300),
        workerPool: !!state.workerPool,
      }), 600);
      markActiveFile(state.fileIdx);
      window.scrollTo(0, 0);
      if (state.fileIdx) setTimeout(() => jumpFile(state.fileIdx), 0);
      return;
    } catch (e) {
      console.error("CodeView failed — legacy renderer", e);
      banner(`CodeView failed: ${e.message} — using legacy renderer`);
      dropCodeView();
      root.remove();
      body.classList.remove("fixed");
      body.style.height = "";
    }
  }

  // ── legacy fallback (no @pierre/diffs bundle, or CodeView error above)
  diff.files.forEach((f, i) => {
    // diff card (lazy body)
    const card = el("div", "fcard");
    card.id = `f${i}`;
    const fh = el("div", "fhead");
    const base = f.path.split("/").pop();
    const dir = f.path.slice(0, f.path.length - base.length);
    const pathEl = el("span", "path");
    pathEl.innerHTML = `<b>${escText(base)}</b><span class="dir">${escText(dir)}</span>`;
    if (f.status === "rename" && f.oldPath) pathEl.title = `renamed from ${f.oldPath}`;
    fh.append(el("span", `st st-${f.status}`, f.status[0].toUpperCase()), pathEl);
    const threadsHere = (threadsByPath.get(f.path) ?? []).length;
    if (threadsHere) fh.append(el("span", "tag", `💬 ${threadsHere}`));
    const generated = /\.generated\.|\.designer\.|\.min\.(js|css)$|package-lock\.json$|bun\.lock/i.test(f.path);
    if (generated) fh.append(el("span", "tag", "generated"));
    if (changedSinceReview(f)) fh.append(el("span", "tag draft", "changed since review"));
    const stats = el("span", "stats"); stats.innerHTML = `<span class="a">+${f.adds}</span><span class="d">−${f.dels}</span>`;
    const cb = el("span", "revcb" + (isReviewed(f) ? " on" : ""), "✓");
    cb.title = "mark reviewed (v)";
    cb.onclick = (e) => { e.stopPropagation(); state.fileIdx = i; toggleReviewed(i); };
    fh.append(stats, cb);
    fh.onclick = () => toggleCollapse(card);
    card.append(fh);
    const fb = el("div", "fbody");
    fb.append(el("div", "pending", "…"));
    // reserve approximate height so the scrollbar is honest before materialization
    const lines = f.hunks.reduce((s, h) => s + h.lines.length, 0);
    fb.style.minHeight = Math.min(lines * 25 + f.hunks.length * 24, 600) + "px";
    card.append(fb);
    // reviewed and generated files start collapsed
    if (isReviewed(f)) { fb.hidden = true; fb.style.minHeight = ""; card.classList.add("reviewed"); }
    else if (generated) { fb.hidden = true; fb.style.minHeight = ""; }
    main.append(card);
    card._file = f;
    card._built = false;
    card._threads = threadsByPath.get(f.path) ?? [];
  });

  // materialize: first two now, rest as they approach the viewport
  // (collapsed cards are skipped — they build on expand instead)
  const cards = [...main.querySelectorAll(".fcard")];
  cards.slice(0, 2).filter((c) => !c.querySelector(".fbody").hidden).forEach(buildFileBody);
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting && !e.target.querySelector(".fbody").hidden) {
      buildFileBody(e.target); io.unobserve(e.target);
    }
  }, { rootMargin: "1200px 0px" });
  cards.slice(2).forEach((c) => io.observe(c));

  markActiveFile(state.fileIdx);
  window.scrollTo(0, 0);
  if (state.fileIdx) setTimeout(() => jumpFile(state.fileIdx), 0);
}

function escText(s) { const d = el("span"); d.textContent = s; return d.innerHTML; }

const curView = () => (state.view === "overview" ? "overview" : "diff");

function threadCard(t) {
  const card = el("div", "thread");
  card.dataset.tid = t.id;
  const h = el("div", "th");
  h.append(el("span", `pill ${t.status}`, t.status), el("span", "", `${t.comments.length} comment${t.comments.length > 1 ? "s" : ""}`), el("span", "sp"));
  // resolve / reopen (thread-level, like ADO's own Resolve button)
  const open = ["active", "pending", "unknown"].includes(t.status);
  const act = el("span", "tact", open ? "resolve" : "reopen");
  act.onclick = async () => {
    act.textContent = "…";
    try {
      await patchJson(`/api/pr/${state.pr.bundle.pr.id}/thread`, { threadId: t.id, status: open ? "fixed" : "active" });
      refreshPr(curView());
    } catch (e) { banner(e.message); act.textContent = open ? "resolve" : "reopen"; }
  };
  h.append(act);
  card.append(h);

  for (const c of t.comments) {
    const cm = el("div", "comment");
    const who = el("div", "who");
    who.innerHTML = `<b>${escText(c.author)}</b><span>${relTime(c.date)} ago</span>`;
    const body = el("div", "body md");
    body.innerHTML = md(c.content);
    if (c.authorId === state.me.id) who.append(commentMenu(t, c, cm, body));
    cm.append(who, body);
    card.append(cm);
  }
  // reply box (Enter to send)
  const rin = buildReplyInput(t);
  card.append(rin);
  return card;
}

// ⋯ menu on your own comments: Edit / Delete
function commentMenu(t, c, cm, body) {
  const wrap = el("span", "cmenu");
  const dots = el("span", "cdots", "⋯");
  const pop = el("div", "cpop");
  pop.hidden = true;
  const item = (label, cls) => el("div", `citem${cls ? " " + cls : ""}`, label);

  const edit = item("Edit");
  edit.onclick = (e) => { e.stopPropagation(); pop.hidden = true; openPop = null; startEdit(t, c, body); };

  const del = item("Delete", "danger");
  del.onclick = async (e) => {
    e.stopPropagation();
    del.textContent = "Deleting…";
    try {
      const r = await fetch(`/api/pr/${state.pr.bundle.pr.id}/comment?threadId=${t.id}&commentId=${c.id}`, { method: "DELETE" });
      if (!r.ok) throw new Error((await r.json()).error || r.status);
      refreshPr(curView());
    } catch (err) { banner(String(err.message || err)); del.textContent = "Delete"; }
  };

  pop.append(edit, del);
  dots.onclick = (e) => {
    e.stopPropagation();
    if (openPop && openPop !== pop) openPop.hidden = true;
    pop.hidden = !pop.hidden;
    del.textContent = "Delete";
    openPop = pop.hidden ? null : pop;
  };
  wrap.append(dots, pop);
  return wrap;
}

function startEdit(t, c, body) {
  if (body.parentElement.querySelector(".editbox")) return;
  const box = el("div", "editbox");
  const ta = el("textarea");
  ta.value = c.content;
  const foot = el("div", "cfoot");
  const save = el("button", "csend", "Save ⏎");
  foot.append(el("span", "hint", "⏎ save · ⇧⏎ newline · esc cancel"), save);
  box.append(ta, foot);
  body.replaceWith(box);
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  const submit = async () => {
    if (!Keyboard.canSubmitComment(ta.value, save.disabled)) return;
    save.disabled = true; save.textContent = "saving…";
    try {
      await patchJson(`/api/pr/${state.pr.bundle.pr.id}/comment`, { threadId: t.id, commentId: c.id, text: ta.value });
      refreshPr(curView());
    } catch (e) { banner(e.message); save.disabled = false; save.textContent = "Save ⏎"; }
  };
  ta.onkeydown = (e) => handleCommentEditorKey(e, () => box.replaceWith(body), submit);
  save.onclick = submit;
}

function buildReplyInput(t) {
  const rin = el("textarea", "replyin");
  rin.rows = 1;
  rin.placeholder = "Leave a reply…";
  const submit = async () => {
    if (!Keyboard.canSubmitComment(rin.value, rin.disabled)) return;
    rin.disabled = true;
    try {
      await postJson(`/api/pr/${state.pr.bundle.pr.id}/comment`,
        { threadId: t.id, parentId: t.comments[0]?.id, text: rin.value });
      refreshPr(curView());
    } catch (err) { banner(err.message); rin.disabled = false; }
  };
  rin.onkeydown = (e) => handleCommentEditorKey(e, () => rin.blur(), submit);
  return rin;
}

function buildFileBody(card) {
  if (card._built) return;
  card._built = true;
  const f = card._file;
  const fb = card.querySelector(".fbody");
  fb.replaceChildren();
  fb.style.minHeight = "";

  if (f.binary) { fb.append(el("div", "binary", "binary file")); attachLooseThreads(card, f, new Map(), new Map()); return; }
  if (!f.hunks.length) { fb.append(el("div", "binary", "no textual changes (mode/rename only)")); attachLooseThreads(card, f, new Map(), new Map()); return; }
  if (tryPierre(card, f, fb)) return; // @pierre/diffs renders; legacy below is the fallback

  // "smart layout": a purely added/deleted file reads better as one calm
  // content block (single gutter, soft edge) than as wall-to-wall diff noise
  const pure = (f.status === "add" || f.status === "delete") && f.hunks.length === 1;
  if (pure) fb.classList.add(f.status === "add" ? "blk-add" : "blk-del");

  const oldRows = new Map(), newRows = new Map();
  let firstHunk = true;
  for (const h of f.hunks) {
    // quiet gap between hunks rather than a loud @@ banner
    if (!pure && !firstHunk) fb.append(el("div", "hunkh", h.header || "⋯"));
    firstHunk = false;
    for (const l of h.lines) {
      const cls = pure ? "blk" : l.t === "+" ? "add" : l.t === "-" ? "del" : "ctx";
      const row = el("div", `dl ${cls}`);
      // single gutter (deleted lines show their old number; everything else the new)
      row.append(el("span", "g", String(l.t === "-" ? l.old : l.new)));
      const tx = el("span", "tx");
      if (l.hl) {
        tx.append(l.text.slice(0, l.hl[0]), Object.assign(el("span", "chg"), { textContent: l.text.slice(l.hl[0], l.hl[1]) }), l.text.slice(l.hl[1]));
      } else tx.textContent = l.text;
      row.append(tx);
      row._line = l;
      fb.append(row);
      if (l.old) oldRows.set(l.old, row);
      if (l.new) newRows.set(l.new, row);
    }
  }
  attachLooseThreads(card, f, oldRows, newRows);
  attachCommentAffordance(fb, f);
  requestHighlight(card, f, oldRows, newRows);
}

// ── CodeView (primary diff renderer) ──

const isGenerated = (f) => /\.generated\.|\.designer\.|\.min\.(js|css)$|package-lock\.json$|bun\.lock/i.test(f.path);
const fileByPath = (path) => state.files.find((f) => f.path === path);
const fileIdxByPath = (path) => state.files.findIndex((f) => f.path === path);

function cvItem(f) {
  const anns = (state.threadsByPath.get(f.path) ?? [])
    .filter((t) => t.line)
    .map((t) => ({ side: t.side === "left" ? "deletions" : "additions", lineNumber: t.line, metadata: { thread: t } }));
  const draft = state.drafts.get(f.path);
  if (draft) anns.push({ side: draft.side, lineNumber: draft.end, metadata: { draft: true, range: draft } });
  return {
    id: f.path,
    type: "diff",
    fileDiff: state.pierreMeta.get(f.path) ?? state.pierreFiles[state.files.indexOf(f)],
    annotations: anns,
    collapsed: state.cvCollapsed.has(f.path),
    version: state.itemVersion.get(f.path) ?? 0,
  };
}

function cvBump(f) {
  state.itemVersion.set(f.path, (state.itemVersion.get(f.path) ?? 0) + 1);
  state.codeView?.updateItem(cvItem(f));
  state.codeView?.render(true); // updateItem only queues; force the paint
  setTimeout(cvSyncCollapsedAttrs, 0);
}

// host attribute mirrors collapsed state → CSS hover/cursor affordance
function cvSyncCollapsedAttrs() {
  if (!state.codeView) return;
  for (const r of state.codeView.getRenderedItems())
    r.element?.toggleAttribute("data-collapsed", state.cvCollapsed.has(r.item.id));
}

function cvOptions() {
  return {
    theme: { dark: "github-dark-default", light: "github-light-default" },
    themeType: "dark",
    diffStyle: state.diffStyle,
    lineDiffType: "word",
    diffIndicators: "none",
    hunkSeparators: "line-info",
    overflow: "wrap",
    stickyHeaders: true,
    layout: { paddingTop: 12, paddingBottom: 90, gap: 14 },
    enableGutterUtility: true,
    lineHoverHighlight: true,
    enableLineSelection: true, // drag line numbers or use Up/Down to select
    onSelectedLinesChange: (sel) => {
      state.cvSel = sel
        ? { path: sel.id, anchor: sel.range.start, head: sel.range.end, side: sel.range.side ?? "additions" }
        : null;
    },
    unsafeCSS: ANNOTATION_CSS,
    onGutterUtilityClick: (range, ctx) => addDraft(ctx.item.id, range),
    renderAnnotation: (a, ctx) => {
      if (a.metadata?.draft) return cvComposer(ctx.item.id, a.metadata.range);
      const elx = threadCard(a.metadata.thread);
      const anchor = state.threadAnchors.find((x) => x.thread.id === a.metadata.thread.id);
      if (anchor) anchor.el = elx;
      return elx;
    },
    // replace the built-in header wholesale: name-first row
    renderCustomHeader: (_fd, ctx) => {
      const f = fileByPath(ctx.item.id);
      return f ? pheadEl(f) : null;
    },
  };
}

// file-type icons: material-icon-theme SVGs (MIT), served at /ficons/<name>.svg;
// unmapped extensions fall back to a tinted text chip
const MATERIAL_ICON = {
  tf: "terraform", tfvars: "terraform", hcl: "terraform",
  yaml: "yaml", yml: "yaml", md: "markdown",
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
  cs: "csharp", cshtml: "razor", razor: "razor", csproj: "xml",
  json: "json", jsonc: "json", toml: "toml", ini: "settings",
  sh: "console", bash: "console", zsh: "console", ps1: "powershell", psm1: "powershell",
  vue: "vue", html: "html", css: "css", scss: "sass", less: "css",
  sql: "database", dockerfile: "docker", xml: "xml", txt: "document",
  py: "python", go: "go", rs: "rust", gitignore: "git",
};
const FILE_CHIP_COLORS = { lock: "#8a8a8a" }; // fallback chip tints (rarely needed now)
function ficonEl(f, withToggle = false) {
  const base = f.path.split("/").pop() ?? "";
  const ext = /^dockerfile/i.test(base) ? "dockerfile"
    : /^\.gitignore$/i.test(base) ? "gitignore"
    : (base.split(".").pop() ?? "").toLowerCase();
  const iconName = MATERIAL_ICON[ext];
  const chip = el("span", "ficon" + (iconName ? " has-img" : ""));
  if (iconName) {
    chip.append(Object.assign(el("img", "fimg"), { src: `/ficons/${iconName}.svg`, alt: ext, draggable: false }));
  } else {
    chip.style.setProperty("--chipc", FILE_CHIP_COLORS[ext] ?? "#8b949e");
    chip.append(el("span", "flbl", ext.toUpperCase().slice(0, 4) || "?"));
  }
  if (withToggle) { // icon morphs to a chevron on hover AND while collapsed
    chip.append(el("span", "fchv", "▾"));
    chip.title = `toggle file · ${PLATFORM_KEYS.alt} click / t: toggle all`;
    chip.onclick = (e) => { e.stopPropagation(); e.altKey ? cvToggleAll() : cvToggleCollapse(f); };
  }
  return chip;
}

function cvToggleAll() {
  if (!state.codeView) return;
  const anyExpanded = state.files.some((f) => !state.cvCollapsed.has(f.path));
  for (const f of state.files) {
    anyExpanded ? state.cvCollapsed.add(f.path) : state.cvCollapsed.delete(f.path);
    state.itemVersion.set(f.path, (state.itemVersion.get(f.path) ?? 0) + 1);
  }
  state.codeView.setItems(state.files.map((f) => cvItem(f)));
  state.codeView.render(true);
  setTimeout(cvSyncCollapsedAttrs, 0);
}

function pheadEl(f) {
  const wrap = el("div", "phead" + (state.cvCollapsed.has(f.path) ? " is-collapsed" : ""));
  wrap.append(ficonEl(f, true));
  const base = f.path.split("/").pop();
  const name = el("span", "pname");
  name.append(el("b", "", base), el("span", "dir", " " + f.path.slice(0, f.path.length - base.length)));
  if (f.status === "rename" && f.oldPath) name.title = `renamed from ${f.oldPath}`;
  wrap.append(name, el("span", "sp"));
  const threads = (state.threadsByPath.get(f.path) ?? []).length;
  if (threads) wrap.append(el("span", "tag", `💬 ${threads}`));
  if (isGenerated(f)) wrap.append(el("span", "tag", "generated"));
  if (changedSinceReview(f)) wrap.append(el("span", "tag amber", "changed since review"));
  const stats = el("span", "pstats");
  stats.innerHTML = `<span class="a">+${f.adds}</span>${f.dels ? ` <span class="d">−${f.dels}</span>` : ""}`;
  wrap.append(stats);
  const cb = el("span", "revcb" + (isReviewed(f) ? " on" : ""), "✓");
  cb.title = "mark reviewed (v)";
  cb.onclick = (e) => { e.stopPropagation(); state.fileIdx = fileIdxByPath(f.path); toggleReviewed(state.fileIdx); };
  wrap.append(cb);
  wrap.onclick = (e) => { e.stopPropagation(); cvToggleCollapse(f); };
  return wrap;
}

// ── keyboard line selection (Up/Down move one line, c comments, esc clears) ──

function cvMoveSel(dir) {
  if (!state.codeView) return;
  const current = state.cvSel;
  const f = current ? fileByPath(current.path) : state.files[state.fileIdx];
  if (!f) {
    if (current) cvClearSel();
    return;
  }
  if (!current) {
    // starting a selection is explicit intent — expand even if reviewed-collapsed
    if (state.cvCollapsed.has(f.path)) cvToggleCollapse(f);
  }
  const next = Keyboard.advanceLineSelection(f, current, dir);
  if (!next) { if (current) cvClearSel(); return; }
  const s = state.cvSel = { ...next, path: f.path };
  const range = { start: Math.min(s.anchor, s.head), end: Math.max(s.anchor, s.head), side: s.side };
  state.codeView.setSelectedLines({ id: s.path, range }, { notify: false });
  state.codeView.scrollTo({ type: "line", id: s.path, lineNumber: s.head, side: s.side, align: "nearest" });
}

function cvClearSel() {
  state.cvSel = null;
  state.codeView?.clearSelectedLines({ notify: false });
}

function cvCommentOnSel() {
  const s = state.cvSel;
  if (!s) return;
  addDraft(s.path, { start: Math.min(s.anchor, s.head), end: Math.max(s.anchor, s.head), side: s.side });
  cvClearSel();
}

function addDraft(path, range) {
  const f = fileByPath(path);
  if (!f) return;
  state.drafts.set(path, {
    start: Math.min(range.start, range.end),
    end: Math.max(range.start, range.end),
    side: range.side ?? "additions",
  });
  cvBump(f);
}
function removeDraft(path) {
  const f = fileByPath(path);
  state.drafts.delete(path);
  if (f) cvBump(f);
}

function cvComposer(path, r) {
  const box = el("div", "composer");
  const ta = el("textarea");
  ta.placeholder = r.start === r.end ? `Comment on line ${r.end}…` : `Comment on lines ${r.start}–${r.end}…`;
  const foot = el("div", "cfoot");
  const send = el("button", "csend", "Comment ⏎");
  foot.append(el("span", "hint", "⏎ send · ⇧⏎ newline · esc discard"), send);
  box.append(ta, foot);
  const submit = async () => {
    if (!Keyboard.canSubmitComment(ta.value, send.disabled)) return;
    send.disabled = true; send.textContent = "posting…";
    try {
      await postJson(`/api/pr/${state.pr.bundle.pr.id}/comment`,
        { path, line: r.start, lineEnd: r.end, side: r.side === "deletions" ? "left" : "right", text: ta.value });
      refreshPr("diff");
    } catch (err) { banner(err.message); send.disabled = false; send.textContent = "Comment ⏎"; }
  };
  ta.onkeydown = (e) => handleCommentEditorKey(e, () => removeDraft(path), submit);
  send.onclick = submit;
  setTimeout(() => ta.focus(), 40);
  return box;
}

// contents → context expansion: fetch for files near the viewport, re-parse
// that file's chunk with contents attached, publish a new item version
function cvLoadVisibleContents() {
  const view = state.codeView;
  if (!view) return;
  for (const rendered of view.getRenderedItems()) {
    const path = rendered.item.id;
    if (state.pierreMeta.has(path) || state.drafts.has(path)) continue;
    const f = fileByPath(path);
    const i = fileIdxByPath(path);
    const chunk = state.pierreRaw?.[i];
    if (!f || !chunk || f.binary) continue;
    state.pierreMeta.set(path, state.pierreFiles[i]); // claim: fetch once
    Promise.all([fileContentsFor(path, "old"), fileContentsFor(path, "new")]).then(([o, n]) => {
      if (state.codeView !== view || (!o && !n)) return;
      const meta2 = window.Pierre.processFile(chunk, {
        isGitDiff: true, oldFile: o, newFile: n,
        cacheKey: `pr${state.pr.bundle.pr.id}i${state.pr.bundle.iterations.latestId}:${path}:full`,
      });
      if (!meta2 || state.drafts.has(path)) return; // don't remount under an open composer
      state.pierreMeta.set(path, meta2);
      cvBump(f);
    }).catch(() => {});
  }
}

let cvScrollRaf = 0;
function cvOnScroll() {
  if (cvScrollRaf) return;
  cvScrollRaf = requestAnimationFrame(() => {
    cvScrollRaf = 0;
    const view = state.codeView;
    if (!view) return;
    cvLoadVisibleContents();
    cvSyncCollapsedAttrs(); // newly mounted (virtualized) rows need the attr
    // scroll-spy the sidebar
    const st = view.getScrollTop() + 80;
    let active = 0;
    state.files.forEach((f, i) => {
      const top = view.getTopForItem(f.path);
      if (top !== undefined && top <= st) active = i;
    });
    if (active !== state.fileIdx) { state.fileIdx = active; markActiveFile(active); }
  });
}

// ── @pierre/diffs render path ──
// Threads and the draft composer are line annotations; the hover 💬 button is
// the library's gutter utility. Any failure falls back to the legacy renderer.

function tryPierre(card, f, fb) {
  const meta = state.pierreFiles?.[state.files.indexOf(f)];
  if (!meta || !window.Pierre) return false;
  try {
    const threads = (state.pr.bundle.threads.file ?? []).filter((t) => t.path === f.path && t.line);
    const anns = threads.map((t) => ({
      side: t.side === "left" ? "deletions" : "additions",
      lineNumber: t.line,
      metadata: { thread: t },
    }));
    const fd = new window.Pierre.FileDiff({
      disableFileHeader: true,   // our card header owns reviewed/stats/collapse
      diffStyle: state.diffStyle,
      overflow: "wrap",
      theme: { dark: "github-dark-default", light: "github-light-default" }, // match app chrome
      themeType: "dark",
      lineDiffType: "word",      // GitHub-style intraline word highlights
      diffIndicators: "none",    // colour carries add/del, no +/- signs
      hunkSeparators: "line-info",
      stickyHeader: false,
      enableGutterUtility: true, // renderGutterUtility alone does NOT enable it (defaults false)
      lineHoverHighlight: true,
      unsafeCSS: ANNOTATION_CSS, // style our annotations inside the shadow root
      renderAnnotation: (a) => {
        if (a.metadata?.draft) return pierreComposer(card, f, a);
        const elx = threadCard(a.metadata.thread);
        const anchor = state.threadAnchors.find((x) => x.thread.id === a.metadata.thread.id);
        if (anchor) anchor.el = elx;
        return elx;
      },
      // native gutter button (their styling/positioning); click = one line,
      // drag down the gutter = multi-line range
      onGutterUtilityClick: (range) => pierreDraft(card, range),
    });
    card._pierre = { fd, anns };
    // containerWrapper (NOT fileContainer): the lib creates its own
    // <diffs-container> inside fb — that element's shadow root carries the
    // core layout stylesheet; a plain div renders unstyled stacked columns
    fd.render({ fileDiff: meta, containerWrapper: fb, lineAnnotations: anns });
    // full contents unlock context expansion between hunks — fetch lazily,
    // then RE-PARSE this file's patch chunk with contents attached (the lib's
    // contract for patch+contents; passing contents to render() instead makes
    // it recompute the whole diff and the line numbers drift)
    const chunk = state.pierreRaw?.[state.files.indexOf(f)];
    if (chunk) Promise.all([fileContentsFor(f.path, "old"), fileContentsFor(f.path, "new")]).then(([o, n]) => {
      if (card._pierre?.fd !== fd || (!o && !n)) return;
      const meta2 = window.Pierre.processFile(chunk, { isGitDiff: true, oldFile: o, newFile: n });
      if (!meta2) return;
      // no container props: render() reuses the previous <diffs-container>
      fd.render({ fileDiff: meta2, lineAnnotations: card._pierre.anns, forceRender: true });
    }).catch(() => {});
    return true;
  } catch (e) {
    console.warn(`pierre render failed for ${f.path} — legacy fallback`, e);
    card._pierre = null;
    fb.replaceChildren();
    return false;
  }
}

async function fileContentsFor(path, side) {
  const entry = state.pr;
  entry.contents ??= new Map();
  const key = `${side}:${path}`;
  if (!entry.contents.has(key)) {
    const p = fetchJson(`/api/pr/${entry.bundle.pr.id}/contents?path=${encodeURIComponent(path)}&side=${side}`)
      .then((r) => (r.data.contents === null ? undefined : { name: r.data.name, contents: r.data.contents }))
      .catch(() => undefined);
    entry.contents.set(key, p);
  }
  return entry.contents.get(key);
}

function pierreDraft(card, range) {
  const p = card._pierre;
  if (!p) return;
  const start = Math.min(range.start, range.end);
  const end = Math.max(range.start, range.end);
  const side = range.side ?? "additions";
  p.anns = p.anns.filter((a) => !a.metadata?.draft);
  p.anns.push({ side, lineNumber: end, metadata: { draft: true, range: { start, end, side } } });
  p.fd.setLineAnnotations([...p.anns]);
  p.fd.rerender(); // setLineAnnotations only stores — rerender() paints
}
function pierreRemoveDraft(card) {
  const p = card._pierre;
  if (!p) return;
  p.anns = p.anns.filter((a) => !a.metadata?.draft);
  p.fd.setLineAnnotations([...p.anns]);
  p.fd.rerender();
}

function pierreComposer(card, f, a) {
  const r = a.metadata.range ?? { start: a.lineNumber, end: a.lineNumber, side: a.side };
  const box = el("div", "composer");
  const ta = el("textarea");
  ta.placeholder = r.start === r.end ? `Comment on line ${r.end}…` : `Comment on lines ${r.start}–${r.end}…`;
  const foot = el("div", "cfoot");
  const send = el("button", "csend", "Comment ⏎");
  foot.append(el("span", "hint", "⏎ send · ⇧⏎ newline · esc discard"), send);
  box.append(ta, foot);
  const submit = async () => {
    if (!Keyboard.canSubmitComment(ta.value, send.disabled)) return;
    send.disabled = true; send.textContent = "posting…";
    try {
      await postJson(`/api/pr/${state.pr.bundle.pr.id}/comment`,
        { path: f.path, line: r.start, lineEnd: r.end, side: r.side === "deletions" ? "left" : "right", text: ta.value });
      refreshPr("diff");
    } catch (err) {
      banner(err.message); send.disabled = false; send.textContent = "Comment ⏎";
    }
  };
  ta.onkeydown = (e) => handleCommentEditorKey(e, () => pierreRemoveDraft(card), submit);
  send.onclick = submit;
  setTimeout(() => ta.focus(), 30);
  return box;
}

// ── commenting (hover bubble → inline composer) ──

function attachCommentAffordance(fb, f) {
  fb.style.position = "relative";
  const bub = el("span", "cbubble", "💬");
  bub.style.display = "none";
  fb.append(bub);
  let cur = null;
  fb.addEventListener("mousemove", (e) => {
    const row = e.target.closest?.(".dl");
    if (!row || !fb.contains(row)) return;
    cur = row;
    bub.style.display = "flex";
    bub.style.top = row.offsetTop + (row.offsetHeight - 22) / 2 + "px";
  });
  fb.addEventListener("mouseleave", () => (bub.style.display = "none"));
  bub.onclick = (e) => { e.stopPropagation(); if (cur) openComposer(f, cur); };
}

function closeComposer() { document.querySelector(".composer")?.remove(); }

function openComposer(f, row) {
  closeComposer();
  const l = row._line;
  const line = l.t === "-" ? l.old : l.new;
  const box = el("div", "composer");
  const ta = el("textarea");
  ta.placeholder = `Comment on line ${line}…`;
  const foot = el("div", "cfoot");
  const send = el("button", "csend", "Comment ⏎");
  foot.append(el("span", "hint", "⏎ send · ⇧⏎ newline · esc discard"), send);
  box.append(ta, foot);
  row.after(box);
  ta.focus();
  const submit = async () => {
    if (!Keyboard.canSubmitComment(ta.value, send.disabled)) return;
    send.disabled = true; send.textContent = "posting…";
    try {
      await postJson(`/api/pr/${state.pr.bundle.pr.id}/comment`,
        { path: f.path, line, side: l.t === "-" ? "left" : "right", text: ta.value });
      refreshPr("diff");
    } catch (err) {
      banner(err.message); send.disabled = false; send.textContent = "Comment ⏎";
    }
  };
  ta.onkeydown = (e) => handleCommentEditorKey(e, closeComposer, submit);
  send.onclick = submit;
}

// reload PR data after a write (server cache was invalidated) keeping position
async function refreshPr(sub) {
  const id = state.pr.bundle.pr.id;
  const y = window.scrollY;
  state.cache.delete(id);
  try {
    const entry = await loadPr(id);
    renderPrView(entry, sub);
    window.scrollTo(0, y);
  } catch (e) { banner(e.message); }
}

function attachLooseThreads(card, f, oldRows, newRows) {
  for (const anchor of state.threadAnchors) {
    if (anchor.thread.path !== f.path) continue;
    const t = anchor.thread;
    const row = t.side === "left" ? oldRows.get(t.line) : newRows.get(t.line);
    const cardEl = threadCard(t);
    anchor.el = cardEl;
    if (row) row.after(cardEl);
    else {
      const note = el("div", "footnote", `↓ thread on ${t.side ?? "file"} line ${t.line ?? "—"} (outside the diff context)`);
      card.querySelector(".fbody").append(note, cardEl);
    }
  }
}

async function requestHighlight(card, f, oldRows, newRows) {
  const id = state.pr.bundle.pr.id;
  state.hud.hlTotal++;
  paintHud();
  try {
    const { data } = await fetchJson(`/api/pr/${id}/hl?path=${encodeURIComponent(f.path)}`);
    if (state.view !== "pr" || state.pr?.bundle.pr.id !== id) return;
    for (const [line, row] of oldRows) if (row._line.t === "-" && data.old[line] !== undefined) swapHl(row, data.old[line]);
    for (const [line, row] of newRows) if (row._line.t !== "-" && data.new[line] !== undefined) swapHl(row, data.new[line]);
  } catch { /* plain text is a fine fallback */ }
  state.hud.hlDone++;
  paintHud();
}

function swapHl(row, html) {
  const tx = row.querySelector(".tx");
  const l = row._line;
  tx.innerHTML = html;
  if (l.hl) wrapRange(tx, l.hl[0], l.hl[1]); // re-apply intraline mark over the token spans
}

// wrap [start,end) character range of el's text content in a .chg span,
// splitting text nodes across token boundaries as needed
function wrapRange(el2, start, end) {
  const walker = document.createTreeWalker(el2, NodeFilter.SHOW_TEXT);
  let pos = 0; const targets = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const len = n.textContent.length;
    const s = Math.max(start - pos, 0), e = Math.min(end - pos, len);
    if (s < e) targets.push([n, s, e]);
    pos += len;
    if (pos >= end) break;
  }
  for (const [n, s, e] of targets) {
    const r = document.createRange();
    r.setStart(n, s); r.setEnd(n, e);
    const span = el("span", "chg");
    try { r.surroundContents(span); } catch { /* crossing boundary: skip */ }
  }
}

// ── review-flow state (per-file reviewed)

function sideRow(f, i) {
  const sf = el("div", "sfile" + (i === state.fileIdx ? " active" : ""));
  sf.dataset.i = i;
  sf.append(ficonEl(f));
  const done = isReviewed(f);
  const stale = changedSinceReview(f);
  const base = f.path.split("/").pop();
  const fn = el("span", "fn");
  fn.append(el("b", "", base), el("span", "dir", f.path.slice(0, f.path.length - base.length)));
  fn.title = stale ? `${f.path} — changed since you reviewed it` : f.path;
  sf.append(fn, el("span", "n", `+${f.adds} −${f.dels}`),
    el("span", `sstate ${done ? "v-approve" : "v-wait"}`, done ? "✓" : stale ? "±" : ""));
  sf.onclick = () => jumpFile(i);
  return sf;
}

function paintProgress() {
  const p = document.getElementById("revprog");
  if (!p) return;
  const done = state.files.filter(isReviewed).length;
  p.textContent = `${done}/${state.files.length} reviewed${done === state.files.length ? " 🎉" : ""}`;
}

function nextUnreviewed(from) {
  for (let k = from + 1; k < state.files.length; k++)
    if (!isReviewed(state.files[k])) return k;
  return -1;
}

function toggleReviewed(i, advance = false) {
  const f = state.files[i];
  const on = !isReviewed(f);
  // optimistic local update; persisted server-side in sqlite keyed by blob
  if (on) state.pr.reviewed[f.path] = f.blob;
  else delete state.pr.reviewed[f.path];
  postJson(`/api/pr/${state.pr.bundle.pr.id}/reviewed`, { path: f.path, blob: f.blob, on })
    .catch((e) => banner(`couldn't save reviewed state: ${e.message}`));
  if (state.codeView) {
    on ? state.cvCollapsed.add(f.path) : state.cvCollapsed.delete(f.path);
    cvBump(f); // remount: header checkbox + collapsed state re-derive
  } else {
    const card = document.getElementById(`f${i}`);
    const fb = card.querySelector(".fbody");
    card.classList.toggle("reviewed", on);
    card.querySelector(".revcb").classList.toggle("on", on);
    if (on) fb.hidden = true;
    else { buildFileBody(card); fb.hidden = false; }
  }
  document.querySelector(`.sfile[data-i="${i}"]`)?.replaceWith(sideRow(f, i));
  paintProgress();
  if (advance && on) {
    const nx = nextUnreviewed(i);
    if (nx >= 0) jumpFile(nx);
  }
}

function toggleCollapse(card) {
  const fb = card.querySelector(".fbody");
  if (fb.hidden) { buildFileBody(card); fb.hidden = false; }
  else fb.hidden = true;
}
function cvToggleCollapse(f) {
  state.cvCollapsed.has(f.path) ? state.cvCollapsed.delete(f.path) : state.cvCollapsed.add(f.path);
  cvBump(f);
}

// ── PR-view navigation

function jumpFile(i) {
  state.fileIdx = Math.max(0, Math.min(i, state.files.length - 1));
  const f = state.files[state.fileIdx];
  if (state.codeView) {
    // expand collapsed (but not reviewed) targets, then scroll the view
    if (state.cvCollapsed.has(f.path) && !isReviewed(f)) cvToggleCollapse(f);
    state.codeView.scrollTo({ type: "item", id: f.path, align: "start" });
    markActiveFile(state.fileIdx);
    return;
  }
  const card = document.getElementById(`f${state.fileIdx}`);
  const fb = card.querySelector(".fbody");
  // jumping to a collapsed (but not reviewed) file expands it
  if (fb.hidden && !card.classList.contains("reviewed")) { buildFileBody(card); fb.hidden = false; }
  else if (!fb.hidden) buildFileBody(card);
  card.scrollIntoView({ block: "start" });
  markActiveFile(state.fileIdx);
}
function markActiveFile(i) {
  document.querySelectorAll(".sfile").forEach((s) => s.classList.toggle("active", +s.dataset.i === i));
  document.querySelector(`.sfile[data-i="${i}"]`)?.scrollIntoView({ block: "nearest" });
}
function jumpThread(dir) {
  if (!state.threadAnchors.length) return;
  state.threadIdx = (state.threadIdx + dir + state.threadAnchors.length) % state.threadAnchors.length;
  const a = state.threadAnchors[state.threadIdx];
  if (state.codeView) {
    const t = a.thread;
    const f = state.files[a.fileIdx];
    if (state.cvCollapsed.has(f.path) && !isReviewed(f)) cvToggleCollapse(f);
    if (t.line) state.codeView.scrollTo({
      type: "line", id: t.path, lineNumber: t.line,
      side: t.side === "left" ? "deletions" : "additions", align: "center",
    });
    else state.codeView.scrollTo({ type: "item", id: t.path, align: "start" });
    setTimeout(() => {
      a.el?.classList.add("flash");
      setTimeout(() => a.el?.classList.remove("flash"), 1200);
    }, 250);
  } else {
    if (!a.el) buildFileBody(document.getElementById(`f${a.fileIdx}`));
    a.el?.scrollIntoView({ block: "center" });
    a.el?.classList.add("flash");
    setTimeout(() => a.el?.classList.remove("flash"), 1200);
  }
  state.fileIdx = a.fileIdx;
  markActiveFile(a.fileIdx);
}

// ───────────────────────── help + keys ─────────────────────────

let helpReturnFocus = null;

const keycap = (key) => `<kbd>${key}</kbd>`;
const helpRows = (rows) => rows.map(([keys, label]) =>
  `<tr><td>${keys}</td><td>${label}</td></tr>`).join("");
const helpSection = (title, rows) =>
  `<section><h3>${title}</h3><table>${helpRows(rows)}</table></section>`;

function renderHelp() {
  $help.setAttribute("role", "dialog");
  $help.setAttribute("aria-modal", "true");
  $help.setAttribute("aria-label", "Keyboard shortcuts");
  $help.onclick = (e) => { if (e.target === $help) hideHelp(); };
}

function showHelp() {
  helpReturnFocus = document.activeElement;
  let sections;
  if (state.view === "diff") {
    sections = [
      helpSection("Diff navigation", [
        [`${keycap("j")} / ${keycap("k")}`, "next / previous file"],
        [`${keycap("↑")} / ${keycap("↓")}`, "move line cursor (to comment on)"],
        [keycap("c"), "comment on selected lines"],
        [keycap("v"), "toggle reviewed, then advance"],
        [`${keycap("n")} / ${keycap("p")}`, "next / previous thread"],
        [keycap("x"), "collapse / expand active file"],
        [keycap("t"), "collapse / expand all files"],
        [keycap("s"), "stacked / split layout"],
        [keycap("/"), "filter files"],
      ]),
      helpSection("Comments", [
        ["hover or drag line numbers", "select comment range"],
        [keycap("⏎"), "send comment or reply"],
        [keycap("⇧⏎"), "insert new line"],
        [keycap(`${PLATFORM_KEYS.mod}⏎`), "also send"],
        [keycap("esc"), "discard composer"],
      ]),
      helpSection("PR", [
        [`${keycap("1")} / ${keycap("2")}`, "overview / diff"],
        [keycap("o"), "open in Azure DevOps"],
        [keycap("r"), "reload for new activity"],
        [keycap("esc"), "clear selection, then inbox"],
        [keycap("?"), "open / close this help"],
        [keycap(`${PLATFORM_KEYS.alt} click`), "toggle all from a file icon"],
      ]),
    ];
  } else if (state.view === "overview") {
    sections = [
      helpSection("PR overview", [
        [`${keycap("1")} / ${keycap("2")}`, "overview / diff"],
        [keycap("⏎"), "open diff"],
        [keycap("o"), "open in Azure DevOps"],
        [keycap("r"), "reload for new activity"],
        [keycap("esc"), "back to inbox"],
        [keycap("?"), "open / close this help"],
      ]),
      helpSection("Comments", [
        [keycap("⏎"), "send reply or save edit"],
        [keycap("⇧⏎"), "insert new line"],
        [keycap(`${PLATFORM_KEYS.mod}⏎`), "also send"],
        [keycap("esc"), "cancel edit"],
      ]),
    ];
  } else {
    sections = [
      helpSection("Inbox", [
        [`${keycap("j")} / ${keycap("k")}`, "move"],
        [`${keycap("↑")} / ${keycap("↓")}`, "move"],
        [keycap("⏎"), "open PR"],
        [keycap("/"), "filter"],
        [keycap("a"), "attached to you / all"],
        [keycap("o"), "open in Azure DevOps"],
        [keycap("r"), "refresh"],
        [keycap("?"), "open / close this help"],
      ]),
    ];
  }
  $help.innerHTML = `<div class="card" tabindex="-1">
    <div class="helphead"><strong>Keyboard shortcuts</strong><button type="button" aria-label="Close keyboard shortcuts">×</button></div>
    <div class="helpcols">${sections.join("")}</div>
  </div>`;
  const card = $help.querySelector(".card");
  card.onclick = (e) => e.stopPropagation();
  card.querySelector("button").onclick = hideHelp;
  $app.inert = true;
  $help.hidden = false;
  requestAnimationFrame(() => card.focus());
}

function hideHelp() {
  if ($help.hidden) return;
  $help.hidden = true;
  $app.inert = false;
  if (helpReturnFocus?.isConnected) helpReturnFocus.focus();
  helpReturnFocus = null;
  $help.replaceChildren();
}

document.addEventListener("keydown", (e) => {
  if (!$help.hidden) {
    const modalShortcut = Keyboard.normalizeShortcut(e);
    if (modalShortcut === "escape" || modalShortcut === "?") {
      e.preventDefault();
      hideHelp();
    } else if (e.key === "Tab") {
      e.preventDefault();
      $help.querySelector("button")?.focus();
    }
    return;
  }
  if (Keyboard.blocksGlobalShortcuts(e)) return;
  const shortcut = Keyboard.normalizeShortcut(e);
  if (!shortcut) return;
  if (e.repeat && Keyboard.isOneShotShortcut(shortcut)) { e.preventDefault(); return; }
  const run = (fn) => { e.preventDefault(); fn(); };
  if (shortcut === "?") { run(showHelp); return; }

  if (state.view === "inbox") {
    const pr = selectedPr();
    switch (shortcut) {
      case "j": case "arrowdown": run(() => {
        state.sel = Math.min(Math.max(0, state.rows.length - 1), state.sel + 1);
        paintSel();
      }); break;
      case "k": case "arrowup": run(() => { state.sel = Math.max(0, state.sel - 1); paintSel(); }); break;
      case "enter": if (pr) run(() => openPr(pr.id)); break;
      case "o": if (pr) run(() => window.open(pr.url)); break;
      case "/": run(() => document.getElementById("filter")?.focus()); break;
      case "a": run(() => {
        state.scope = state.scope === "mine" ? "all" : "mine";
        renderList();
        prefetch();
      }); break;
      case "r": run(() => boot(true)); break;
    }
  } else {
    // keys shared by both PR views
    switch (shortcut) {
      case "escape": run(() => {
        if (state.view === "diff" && state.cvSel) cvClearSel(); // selection first
        else { renderInbox(); paintHud(); }
      }); return;
      case "o": run(() => window.open(state.pr.bundle.pr.url)); return;
      case "1": run(() => renderPrView(state.pr, "overview")); return;
      case "2": run(() => renderPrView(state.pr, "diff")); return;
      case "r": run(() => { banner(""); refreshPr(curView()); }); return;
    }
    if (state.view === "overview") {
      if (shortcut === "enter") run(() => renderPrView(state.pr, "diff"));
      return;
    }
    if (shortcut === "t") { run(cvToggleAll); return; }
    switch (shortcut) {
      case "arrowdown": run(() => cvMoveSel(1)); break;
      case "arrowup": run(() => cvMoveSel(-1)); break;
      case "j": run(() => jumpFile(state.fileIdx + 1)); break;
      case "k": run(() => jumpFile(state.fileIdx - 1)); break;
      case "c": run(cvCommentOnSel); break;
      case "v": run(() => toggleReviewed(state.fileIdx, true)); break;
      case "n": run(() => jumpThread(1)); break;
      case "p": run(() => jumpThread(-1)); break;
      case "x": run(() => {
        const f = state.files[state.fileIdx];
        if (!f) return;
        if (state.codeView) cvToggleCollapse(f);
        else {
          const card = document.getElementById(`f${state.fileIdx}`);
          if (card) toggleCollapse(card);
        }
      }); break;
      case "s": run(() => setDiffStyle(state.diffStyle === "unified" ? "split" : "unified")); break;
      case "/": run(() => document.querySelector(".sfilter")?.focus()); break;
    }
  }
});

function selectedPr() {
  const row = state.rows[state.sel];
  return row ? state.prs.find((p) => p.id === +row.dataset.id) : null;
}

// ───────────────────────── boot ─────────────────────────

async function boot(refresh = false) {
  try {
    banner("");
    const [me, prs] = await Promise.all([fetchJson("/api/me"), fetchJson("/api/prs")]);
    state.me = me.data;
    state.prs = prs.data;
    const hm = location.hash.match(/^#pr\/(\d+)(\/diff)?/); // read BEFORE renderInbox clears it
    renderInbox();
    if (!refresh && hm) openPr(+hm[1], hm[2] ? "diff" : "overview");
    prefetch();
    // worker pool disabled: the bundled worker boots but never answers jobs,
    // which starves every diff render (blank pane). Main-thread highlighting
    // is fine. TODO: debug @pierre/diffs worker protocol under Bun bundling.
    state.workerPool = undefined;
    // warm the main-thread highlighter too (worker misses + legacy path)
    window.Pierre?.preloadHighlighter({
      themes: ["github-dark-default", "github-light-default"],
      langs: ["csharp", "typescript", "javascript", "vue", "json", "yaml"],
    }).catch(() => {});
  } catch (e) {
    banner(`can't reach ADO: ${e.message} — is \`az login\` current?`);
    $app.replaceChildren(el("div", "boot", "startup failed — see banner"));
  }
}
renderHelp();
boot();
