#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// Provision and inspect Gappu families. Runs on the host next to server.js (Node 22+).
// Changes take effect on the very next request: the server reads SQLite directly, no cache.
//
//   gappu-admin create --label "Tosu's family" --contact +91... [--plan trial|monthly|yearly|channel_school]
//                      [--months N | --no-expiry] [--cap-min N] [--channel edunodex:<school>] [--token <existing>]
//   gappu-admin renew <id> [--months 1] [--plan monthly]
//   gappu-admin suspend|resume|revoke <id>
//   gappu-admin rotate <id>                 new token, old one stops working
//   gappu-admin set-cap <id> <minutes>
//   gappu-admin list
//   gappu-admin usage [<id>] [--month 2026-09]
//   gappu-admin backup [<dir>]              VACUUM INTO <dir>/gappu-YYYY-MM-DD.db, keeps 14
//
// Labels and contacts are for billing/support only. Never put a child's full name in a label.

import { randomInt, randomBytes } from "node:crypto";
import { readdirSync, unlinkSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { openDb, sha256Hex, monthKey, PLANS, DEFAULT_CAP_S } from "../src/entitlements.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const db = openDb(process.env.GAPPU_DB || path.join(ROOT, "data", "gappu.db"));

const [cmd, ...rest] = process.argv.slice(2);
const flags = {}, args = [];
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (!a.startsWith("--")) { args.push(a); continue; }
  const next = rest[i + 1];
  if (next === undefined || next.startsWith("--")) flags[a.slice(2)] = true;
  else { flags[a.slice(2)] = next; i++; }
}

const die = (msg) => { console.error(msg); process.exit(1); };
const now = () => new Date().toISOString();
const event = (id, kind, detail = {}) =>
  db.prepare("INSERT INTO events (ts, family_id, kind, detail) VALUES (?, ?, ?, ?)").run(now(), id, kind, JSON.stringify(detail));

// Typed by a parent on an iPad: lowercase, no look-alikes (0/o, 1/l/i), grouped. ~99 bits.
const ALPHA = "23456789abcdefghjkmnpqrstuvwxyz";
function newToken() {
  const c = Array.from({ length: 20 }, () => ALPHA[randomInt(ALPHA.length)]).join("");
  return c.match(/.{5}/g).join("-");
}
const newId = () => "fam_" + randomBytes(5).toString("hex");

function addMonths(fromIso, n) {
  const base = fromIso && Date.parse(fromIso) > Date.now() ? new Date(fromIso) : new Date();
  base.setUTCMonth(base.getUTCMonth() + n);
  return base.toISOString();
}
function months(v, dflt) {
  const n = v === undefined ? dflt : Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 36) die("--months must be a whole number 1-36");
  return n;
}
function plan(v) {
  if (!PLANS.includes(v)) die(`--plan must be one of ${PLANS.join(", ")}`);
  return v;
}
function family(id) {
  const f = db.prepare("SELECT * FROM families WHERE id = ?").get(id || "");
  if (!f) die(`No family ${id}`);
  return f;
}
const set = (id, fields) => {
  const keys = Object.keys(fields);
  db.prepare(`UPDATE families SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).run(...keys.map((k) => fields[k]), id);
};
const show = (f) => {
  const u = db.prepare("SELECT audio_s FROM usage_months WHERE family_id = ? AND month = ?").get(f.id, monthKey());
  const used = Math.round(((u && u.audio_s) || 0) / 60);
  const exp = f.expires_at ? f.expires_at.slice(0, 10) : "never";
  const c = db.prepare("SELECT max(ts) AS ts FROM events WHERE family_id = ? AND kind = 'consent'").get(f.id);
  const consent = c && c.ts ? c.ts.slice(0, 10) : "none     ";
  console.log(`${f.id}  ${f.status.padEnd(9)} ${f.plan.padEnd(14)} expires ${exp}  consent ${consent}  ${used}/${Math.round(f.monthly_cap_s / 60)} min  ${f.label}  <${f.contact}>${f.channel ? "  " + f.channel : ""}`);
};

switch (cmd) {
  case "create": {
    if (typeof flags.label !== "string" || typeof flags.contact !== "string") die("create needs --label and --contact");
    const p = plan(flags.plan || "trial");
    const token = typeof flags.token === "string" ? flags.token.trim() : newToken();
    if (token.length < 16) die("--token must be at least 16 characters");
    const hash = sha256Hex(token);
    if (db.prepare("SELECT 1 FROM families WHERE token_hash = ?").get(hash)) die("That token already belongs to a family");
    let expires = null;
    if (!flags["no-expiry"]) {
      if (p === "trial" && flags.months === undefined) expires = new Date(Date.now() + 14 * 86400_000).toISOString();
      else expires = addMonths(null, months(flags.months, p === "yearly" ? 12 : 1));
    }
    const cap = flags["cap-min"] === undefined ? DEFAULT_CAP_S : Math.round(Number(flags["cap-min"]) * 60);
    if (!(cap > 0)) die("--cap-min must be a positive number");
    const id = newId();
    db.prepare(`INSERT INTO families (id, label, contact, plan, status, token_hash, monthly_cap_s, channel, created_at, expires_at)
                VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`)
      .run(id, flags.label, flags.contact, p, hash, cap, typeof flags.channel === "string" ? flags.channel : null, now(), expires);
    event(id, "create", { plan: p, expires_at: expires, cap_s: cap, adopted_token: typeof flags.token === "string" });
    show(family(id));
    if (typeof flags.token !== "string") console.log(`\nToken (shown once, type it on the iPad): ${token}`);
    break;
  }
  case "renew": {
    const f = family(args[0]);
    const n = months(flags.months, 1);
    const fields = { expires_at: addMonths(f.expires_at, n), status: "active" };
    if (flags.plan) fields.plan = plan(flags.plan);
    set(f.id, fields);
    event(f.id, "renew", { months: n, ...fields });
    show(family(f.id));
    break;
  }
  case "suspend": case "resume": case "revoke": {
    const f = family(args[0]);
    const status = { suspend: "past_due", resume: "active", revoke: "cancelled" }[cmd];
    set(f.id, { status });
    event(f.id, cmd, { status });
    show(family(f.id));
    break;
  }
  case "rotate": {
    const f = family(args[0]);
    const token = newToken();
    set(f.id, { token_hash: sha256Hex(token) });
    event(f.id, "rotate");
    show(family(f.id));
    console.log(`\nNew token (shown once, the old one stopped working): ${token}`);
    break;
  }
  case "set-cap": {
    const f = family(args[0]);
    const cap = Math.round(Number(args[1]) * 60);
    if (!(cap > 0)) die("set-cap <id> <minutes>");
    set(f.id, { monthly_cap_s: cap });
    event(f.id, "set-cap", { cap_s: cap });
    show(family(f.id));
    break;
  }
  case "list":
    for (const f of db.prepare("SELECT * FROM families ORDER BY created_at").all()) show(f);
    break;
  case "usage": {
    const month = typeof flags.month === "string" ? flags.month : monthKey();
    const rows = args[0]
      ? db.prepare("SELECT u.*, f.label FROM usage_months u JOIN families f ON f.id = u.family_id WHERE u.family_id = ? ORDER BY month").all(args[0])
      : db.prepare("SELECT u.*, f.label FROM usage_months u JOIN families f ON f.id = u.family_id WHERE month = ? ORDER BY audio_s DESC").all(month);
    for (const r of rows) console.log(`${r.month}  ${r.family_id}  ${String(r.turns).padStart(5)} turns  ${String(Math.round(r.audio_s / 60)).padStart(5)} min  ${String(r.gemini_calls).padStart(5)} calls  ${r.label}`);
    if (!rows.length) console.log("No usage.");
    break;
  }
  case "backup": {
    const dir = args[0] || path.join(os.homedir(), "backups", "gappu");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `gappu-${new Date().toISOString().slice(0, 10)}.db`);
    if (existsSync(file)) unlinkSync(file);
    db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    const old = readdirSync(dir).filter((n) => /^gappu-\d{4}-\d\d-\d\d\.db$/.test(n)).sort().slice(0, -14);
    for (const n of old) unlinkSync(path.join(dir, n));
    console.log(`${now()} backup ${file}${old.length ? `, pruned ${old.length}` : ""}`);
    break;
  }
  default:
    die("usage: gappu-admin create|renew|suspend|resume|revoke|rotate|set-cap|list|usage|backup  (see header of bin/gappu-admin.js)");
}
