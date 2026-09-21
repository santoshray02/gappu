#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// Provision and inspect Gappu families. Runs on the host next to server.js (Node 22+).
// Changes take effect on the very next request: the server reads SQLite directly, no cache.
//
//   gappu-admin create --email parent@gmail.com --label "Sharma family" [--contact +91...]
//                      [--plan trial|monthly|yearly|channel_school] [--months N | --no-expiry]
//                      [--cap-min N] [--channel edunodex:<school>]
//        The parent then taps "Sign in with Google" on the iPad with that Gmail address.
//   gappu-admin set-email <id> <email>      change who may sign in (unbinds the old Google account)
//   gappu-admin devices <id>                signed-in iPads
//   gappu-admin revoke-device <hash-prefix> sign one iPad out (e.g. lost or given away)
//   gappu-admin renew <id> [--months 1] [--plan monthly]
//   gappu-admin suspend|resume|revoke <id>
//   gappu-admin set-cap <id> <minutes>
//   gappu-admin list
//   gappu-admin usage [<id>] [--month 2026-09]
//   gappu-admin backup [<dir>]              VACUUM INTO <dir>/gappu-YYYY-MM-DD.db, keeps 14
//
// Labels and contacts are for billing/support only. Never put a child's full name in a label.

import { randomBytes } from "node:crypto";
import { readdirSync, unlinkSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { openDb, monthKey, PLANS, DEFAULT_CAP_S } from "../src/entitlements.js";

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

function email(v) {
  const e = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) die("need a valid --email");
  const other = db.prepare("SELECT id FROM families WHERE email = ?").get(e);
  if (other) die(`${e} already belongs to ${other.id}`);
  return e;
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
  const devs = db.prepare("SELECT count(*) AS n FROM devices WHERE family_id = ? AND revoked_at IS NULL").get(f.id).n;
  console.log(`${f.id}  ${f.status.padEnd(9)} ${f.plan.padEnd(14)} expires ${exp}  consent ${consent}  ${devs} iPad${devs === 1 ? " " : "s"}  ${used}/${Math.round(f.monthly_cap_s / 60)} min  ${f.label}  ${f.email || "(no email)"}${f.contact !== f.email ? "  <" + f.contact + ">" : ""}${f.channel ? "  " + f.channel : ""}`);
};

switch (cmd) {
  case "create": {
    if (typeof flags.label !== "string") die("create needs --email and --label");
    const e = email(flags.email);
    const p = plan(flags.plan || "trial");
    let expires = null;
    if (!flags["no-expiry"]) {
      if (p === "trial" && flags.months === undefined) expires = new Date(Date.now() + 14 * 86400_000).toISOString();
      else expires = addMonths(null, months(flags.months, p === "yearly" ? 12 : 1));
    }
    const cap = flags["cap-min"] === undefined ? DEFAULT_CAP_S : Math.round(Number(flags["cap-min"]) * 60);
    if (!(cap > 0)) die("--cap-min must be a positive number");
    const id = newId();
    db.prepare(`INSERT INTO families (id, label, contact, email, plan, status, monthly_cap_s, channel, created_at, expires_at)
                VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`)
      .run(id, flags.label, typeof flags.contact === "string" ? flags.contact : e, e, p, cap,
        typeof flags.channel === "string" ? flags.channel : null, now(), expires);
    event(id, "create", { plan: p, expires_at: expires, cap_s: cap });
    show(family(id));
    console.log(`\nTell the parent: open Gappu on the iPad and tap "Sign in with Google" with ${e}.`);
    break;
  }
  case "set-email": {
    const f = family(args[0]);
    const e = email(args[1]);
    set(f.id, { email: e, google_sub: null });
    event(f.id, "set-email", {});
    show(family(f.id));
    break;
  }
  case "devices": {
    const f = family(args[0]);
    for (const d of db.prepare("SELECT * FROM devices WHERE family_id = ? ORDER BY created_at").all(f.id)) {
      console.log(`${d.token_hash.slice(0, 12)}  ${d.via.padEnd(6)}  added ${d.created_at.slice(0, 10)}  last seen ${(d.last_seen_at || "never").slice(0, 16)}${d.revoked_at ? "  REVOKED " + d.revoked_at.slice(0, 10) : ""}`);
    }
    break;
  }
  case "revoke-device": {
    const prefix = String(args[0] || "");
    if (!/^[0-9a-f]{8,64}$/.test(prefix)) die("revoke-device <hash-prefix of 8+ hex chars> (see: devices <id>)");
    const rows = db.prepare("SELECT * FROM devices WHERE token_hash LIKE ? AND revoked_at IS NULL").all(prefix + "%");
    if (rows.length !== 1) die(`${rows.length} active devices match ${prefix}`);
    db.prepare("UPDATE devices SET revoked_at = ? WHERE token_hash = ?").run(now(), rows[0].token_hash);
    event(rows[0].family_id, "revoke-device", { device: prefix });
    console.log(`Signed out ${prefix} (${rows[0].family_id}).`);
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
    die("usage: gappu-admin create|set-email|devices|revoke-device|renew|suspend|resume|revoke|set-cap|list|usage|backup  (see header of bin/gappu-admin.js)");
}
