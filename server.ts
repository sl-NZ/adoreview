/**
 * Local review server. Binds to loopback only — this is a personal tool that
 * uses YOUR az session; it must never be reachable from the network.
 *
 *   mise run dev   →  http://localhost:4680
 */
import { Database } from "bun:sqlite";
import * as ado from "./ado";

const PORT = Number(process.env.PORT ?? 4680); // PORT env (e.g. preview supervisors) wins
const UI = `${import.meta.dir}/ui`;

// fail fast with a friendly message rather than a confusing 404 storm later
const cfgErr = ado.configError();
if (cfgErr) {
  console.error(`\n✗ Missing config: ${cfgErr}.\n  Copy .env.example → .env and fill it in, then restart.\n`);
  process.exit(1);
}
console.log(`auth mode: ${ado.AUTH_MODE === "pat" ? "PAT (ADO_PAT)" : "az login (Entra token)"}`);

// local review state — bun:sqlite is built in, nothing extra for mise to install.
// reviewed is keyed by the file's blob SHA, so a push that changes the file
// automatically invalidates the checkmark.
const db = new Database(`${import.meta.dir}/data.db`);
db.run(`CREATE TABLE IF NOT EXISTS reviewed (pr INTEGER, path TEXT, blob TEXT, at INTEGER, PRIMARY KEY (pr, path))`);

// bundle the @pierre/diffs browser module once at startup (~fast, cached by bun)
const build = await Bun.build({
  entrypoints: [`${UI}/pierre-entry.ts`, `${UI}/pierre-worker.ts`],
  outdir: `${UI}/dist`,
  target: "browser",
  format: "esm",
  splitting: true,
  minify: true,
  sourcemap: "none",
});
if (!build.success) console.error("⚠ pierre bundle failed:", ...build.logs);
else console.log(`✓ @pierre/diffs bundle: ${build.outputs.length} file(s)`);

const json = (data: unknown, status = 200, ms?: number) =>
  Response.json(data, {
    status,
    headers: { "cache-control": "no-store", ...(ms !== undefined ? { "x-server-ms": ms.toFixed(0) } : {}) },
  });

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;
    const t0 = performance.now();
    try {
      const noStore = { "cache-control": "no-store" };
      // file-type icons from material-icon-theme (MIT)
      const icon = p.match(/^\/ficons\/([a-z0-9_-]+\.svg)$/);
      if (icon) return new Response(
        Bun.file(`${import.meta.dir}/node_modules/material-icon-theme/icons/${icon[1]}`),
        { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" } });
      if (p.startsWith("/dist/") && !p.includes("..")) return new Response(Bun.file(`${UI}${p}`), { headers: noStore });
      if (p === "/" || p === "/index.html") return new Response(Bun.file(`${UI}/index.html`), { headers: noStore });
      if (p === "/app.js") return new Response(Bun.file(`${UI}/app.js`), { headers: { "content-type": "text/javascript", ...noStore } });
      if (p === "/keyboard.js") return new Response(Bun.file(`${UI}/keyboard.js`), { headers: { "content-type": "text/javascript", ...noStore } });
      if (p === "/style.css") return new Response(Bun.file(`${UI}/style.css`), { headers: { "content-type": "text/css", ...noStore } });

      if (p === "/api/log" && req.method === "POST") {
        console.error("[client]", JSON.stringify(await req.json()));
        return json({ ok: true });
      }
      if (p === "/api/me") return json({ ...(await ado.me()), org: ado.ORG, project: ado.PROJECT }, 200, performance.now() - t0);
      if (p === "/api/prs") return json(await ado.listPrs(), 200, performance.now() - t0);

      const m = p.match(/^\/api\/pr\/(\d+)(?:\/(diff|hl|reviewed|comment|contents|thread|pulse))?$/);
      if (m) {
        const id = +m[1];
        if (!m[2]) return json((await ado.bundle(id)).data, 200, performance.now() - t0);
        if (m[2] === "diff") return json(await ado.diff(id), 200, performance.now() - t0);
        if (m[2] === "pulse") return json(await ado.pulse(id), 200, performance.now() - t0);
        if (m[2] === "reviewed") {
          if (req.method === "POST") {
            const b = await req.json() as { path: string; blob: string; on: boolean };
            if (b.on) db.run(
              `INSERT INTO reviewed VALUES (?1, ?2, ?3, ?4)
               ON CONFLICT (pr, path) DO UPDATE SET blob = ?3, at = ?4`,
              [id, b.path, b.blob, Date.now()]);
            else db.run(`DELETE FROM reviewed WHERE pr = ?1 AND path = ?2`, [id, b.path]);
            return json({ ok: true });
          }
          const rows = db.query(`SELECT path, blob FROM reviewed WHERE pr = ?1`).all(id) as any[];
          return json(Object.fromEntries(rows.map((r) => [r.path, r.blob])), 200, performance.now() - t0);
        }
        if (m[2] === "comment" && req.method === "POST")
          return json(await ado.postComment(id, await req.json() as any), 200, performance.now() - t0);
        if (m[2] === "comment" && req.method === "PATCH") {
          const b = await req.json() as { threadId: number; commentId: number; text: string };
          return json(await ado.updateComment(id, b.threadId, b.commentId, b.text), 200, performance.now() - t0);
        }
        if (m[2] === "thread" && req.method === "PATCH") {
          const b = await req.json() as { threadId: number; status: any };
          return json(await ado.setThreadStatus(id, b.threadId, b.status), 200, performance.now() - t0);
        }
        if (m[2] === "comment" && req.method === "DELETE") {
          const tid = +(url.searchParams.get("threadId") ?? 0);
          const cid = +(url.searchParams.get("commentId") ?? 0);
          if (!tid || !cid) return json({ error: "threadId and commentId required" }, 400);
          return json(await ado.deleteComment(id, tid, cid), 200, performance.now() - t0);
        }
        if (m[2] === "contents") {
          const cpath = url.searchParams.get("path");
          const side = url.searchParams.get("side");
          if (!cpath || (side !== "old" && side !== "new")) return json({ error: "path and side=old|new required" }, 400);
          return json(await ado.fileContents(id, cpath, side), 200, performance.now() - t0);
        }
        const path = url.searchParams.get("path");
        if (!path) return json({ error: "path required" }, 400);
        return json(await ado.highlightFile(id, path), 200, performance.now() - t0);
      }
      return json({ error: "not found" }, 404);
    } catch (e: any) {
      const status = e instanceof ado.HttpError ? e.status : 500;
      console.error(`✗ ${p} → ${status}: ${e.message}`);
      return json({ error: e.message }, status);
    }
  },
});

console.log(`review → http://localhost:${server.port}   [${ado.ORG}/${ado.PROJECT}]`);
