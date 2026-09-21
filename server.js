// Runs the Cloudflare Worker in plain Node (22+ for node:sqlite) for self-hosting behind a
// reverse proxy. Same code path as Cloudflare: src/worker.js gets a Request and
// an env; ASSETS is a tiny static file server for public/.
//
//   PORT=10800 HOST=0.0.0.0 GEMINI_API_KEY=... node server.js   (families: bin/gappu-admin.js)

import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import worker from "./src/worker.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, "public");
const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || "127.0.0.1";
const MAX_BODY = 4_000_000; // base64 audio cap in worker is 2 MB

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const ASSETS = {
  async fetch(request) {
    let p = decodeURIComponent(new URL(request.url).pathname);
    if (p.endsWith("/")) p += "index.html";
    const file = path.normalize(path.join(PUBLIC, p));
    if (!file.startsWith(PUBLIC + path.sep)) return new Response("Not found", { status: 404 });
    try {
      if (!(await stat(file)).isFile()) return new Response("Not found", { status: 404 });
      const body = await readFile(file);
      return new Response(body, {
        headers: {
          "content-type": TYPES[path.extname(file)] || "application/octet-stream",
          "cache-control": "no-cache",
        },
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  },
};

// Per-family tokens from SQLite (Node 24 LTS; 22.13+ minimum for node:sqlite) unless GAPPU_DB=off, which restores the
// single APP_TOKEN mode. With the DB on, APP_TOKEN is deliberately NOT passed to the
// worker, so a wiring mistake fails closed (401) instead of falling back to an uncapped token.
// If the DB can't open, the process dies at startup and systemd keeps retrying: loud.
const DB_PATH = process.env.GAPPU_DB || path.join(ROOT, "data", "gappu.db");
let ENTITLEMENTS;
if (DB_PATH !== "off") {
  const { openDb, createStore } = await import("./src/entitlements.js");
  ENTITLEMENTS = createStore(openDb(DB_PATH));
}

const env = {
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  APP_TOKEN: ENTITLEMENTS ? undefined : process.env.APP_TOKEN,
  GEMINI_MODEL: process.env.GEMINI_MODEL,
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
  GOOGLE_AUTH_URL: process.env.GOOGLE_AUTH_URL,   // test overrides only
  GOOGLE_TOKEN_URL: process.env.GOOGLE_TOKEN_URL,
  GEMINI_BASE_URL: process.env.GEMINI_BASE_URL,
  ENTITLEMENTS,
  ASSETS,
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

http.createServer(async (req, res) => {
  try {
    const proto = req.headers["x-forwarded-proto"] || "http";
    const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost";
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const request = new Request(`${proto}://${host}${req.url}`, {
      method: req.method,
      headers: req.headers,
      body: hasBody ? await readBody(req) : undefined,
    });
    const response = await worker.fetch(request, env);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (e) {
    console.error(e);
    res.writeHead(e.message === "body too large" ? 413 : 500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: e.message === "body too large" ? "Audio too long" : "Server error" }));
  }
}).listen(PORT, HOST, () => console.log(`gappu listening on http://${HOST}:${PORT} (${ENTITLEMENTS ? "families: " + DB_PATH : "single APP_TOKEN"})`));
