import http from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { config, loadContext, Generator, artPrompt } from "./core.mjs";
export function createApp(c = config(), fetcher = fetch) {
  if (
    (c.real ||
      c.key ||
      c.imageKey ||
      !["127.0.0.1", "localhost", "::1"].includes(c.host)) &&
    c.token.length < 24
  )
    throw new Error(
      "Set DASHBOARD_TOKEN to at least 24 characters before enabling providers, real data, or remote binding",
    );
  const generator = new Generator(c, fetcher),
    snapshots = new Map();
  return http.createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    const send = (status, value) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    try {
      const pathname = new URL(req.url, "http://localhost").pathname;
      if (pathname.startsWith("/api/")) {
        if (c.token) {
          const a = Buffer.from(req.headers.authorization || ""),
            b = Buffer.from("Bearer " + c.token);
          if (a.length !== b.length || !timingSafeEqual(a, b))
            return send(401, { error: "Enter the dashboard access token" });
        }
        if (
          req.method !== "POST" ||
          req.headers["content-type"] !== "application/json" ||
          req.headers["x-dashboard-request"] !== "1"
        )
          return send(403, { error: "JSON dashboard requests only" });
        let raw = "";
        for await (const chunk of req) {
          raw += chunk;
          if (Buffer.byteLength(raw) > 8192)
            return send(413, { error: "Request too large" });
        }
        let b;
        try {
          b = JSON.parse(raw);
        } catch {
          return send(400, { error: "Invalid JSON" });
        }
        if (!b || typeof b !== "object" || Array.isArray(b))
          return send(400, { error: "Invalid request" });
        const now = Date.now();
        for (const [id, s] of snapshots)
          if (s.expires < now) snapshots.delete(id);
        if (pathname === "/api/config")
          return send(200, {
            realEnabled: c.real && !!c.ns && !!c.nsToken,
            models: c.models,
            textProvider: c.base ? new URL(c.base).host : null,
            imageProvider: c.imageBase ? new URL(c.imageBase).host : null,
            imageModel: c.imageModel,
            daily: c.daily,
            textCost: c.textCost,
            imageCost: c.imageCost,
          });
        if (pathname === "/api/context") {
          const ctx = await loadContext(c, b.mode, now, fetcher);
          const id = randomUUID();
          if (snapshots.size >= 32)
            snapshots.delete(snapshots.keys().next().value);
          snapshots.set(id, { ctx, expires: now + 300000 });
          return send(200, { id, context: ctx });
        }
        if (pathname === "/api/generate") {
          const s = snapshots.get(b.id);
          if (!s)
            return send(400, {
              error: "Preview expired. Load the three-hour window again.",
            });
          return send(200, await generator.run(s.ctx, b));
        }
        if (pathname === "/api/art-preview") {
          const s = snapshots.get(b.id);
          if (!s) return send(400, { error: "Preview expired" });
          return send(200, { prompt: artPrompt(s.ctx, b.artStyle) });
        }
        return send(404, { error: "Not found" });
      }
      const files = {
        "/": ["index.html", "text/html"],
        "/app.js": ["app.js", "text/javascript"],
        "/style.css": ["style.css", "text/css"],
      };
      if (req.method !== "GET" || !files[pathname])
        return send(404, { error: "Not found" });
      const [file, type] = files[pathname];
      res.writeHead(200, { "Content-Type": type });
      res.end(await readFile(new URL("./public/" + file, import.meta.url)));
    } catch (e) {
      // Never return upstream bodies, URLs, credentials, or health payloads in errors/logs.
      const safe =
        /^(Explicit|Invalid|Question|Real data|Offline|Text provider|Image provider|Daily|Budget|Clock|Matching|Generation|Provider must|Data missing)/.test(
          e.message,
        );
      send(400, {
        error: safe
          ? e.message
          : "Request failed. Check server configuration or upstream availability; no retry was sent.",
      });
    }
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const c = config();
  const app = createApp(c);
  app.listen(c.port, c.host, () =>
    console.log(`Nightscout companion listening on ${c.host}:${c.port}`),
  );
}
