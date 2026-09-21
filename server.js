// Runs the Cloudflare Worker in plain Node (18+) for self-hosting behind a
// reverse proxy. Same code path as Cloudflare: src/worker.js gets a Request and
// an env; ASSETS is a tiny static file server for public/.
//
//   PORT=10800 HOST=0.0.0.0 GEMINI_API_KEY=... APP_TOKEN=... node server.js

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

const env = {
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  APP_TOKEN: process.env.APP_TOKEN,
  GEMINI_MODEL: process.env.GEMINI_MODEL,
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
}).listen(PORT, HOST, () => console.log(`gappu listening on http://${HOST}:${PORT}`));
