// Entitlement store for self-hosting (Node 22+, node:sqlite). Not used on Cloudflare.
// Families (plan, status, cap, the parent's Google email), their signed-in devices,
// and monthly usage counts.
// Never store content here: no audio, no heard/reply, no memories, no alerts. Counts only.
//
// Policy (401/402/429) lives in src/worker.js; this file is storage.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";

export const PLANS = ["trial", "monthly", "yearly", "channel_school"];
export const STATUSES = ["active", "past_due", "cancelled"];
export const DEFAULT_CAP_S = 54000; // 30 min/day * 30
const RATE_PER_MIN = 20;
const LOGIN_TTL_MS = 10 * 60_000;
const MAX_PENDING_LOGINS = 1000;

// Schema version 2. Version 1 (2026-09-21 morning) kept one token_hash on families;
// migrate() moves it into devices.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS families (
  id            TEXT PRIMARY KEY,
  label         TEXT NOT NULL,
  contact       TEXT NOT NULL,
  email         TEXT UNIQUE,                 -- lowercased Google email allowed to sign in
  google_sub    TEXT UNIQUE,                 -- bound on first sign-in; a different sub is refused
  plan          TEXT NOT NULL DEFAULT 'trial',
  status        TEXT NOT NULL DEFAULT 'active',
  monthly_cap_s INTEGER NOT NULL DEFAULT ${DEFAULT_CAP_S},
  channel       TEXT,
  created_at    TEXT NOT NULL,
  expires_at    TEXT
);
CREATE TABLE IF NOT EXISTS devices (
  token_hash   TEXT PRIMARY KEY,             -- sha256 of the device token; the raw token lives only on the iPad
  family_id    TEXT NOT NULL,
  via          TEXT NOT NULL,                -- 'google' | 'legacy'
  created_at   TEXT NOT NULL,
  last_seen_at TEXT,
  revoked_at   TEXT
);
CREATE INDEX IF NOT EXISTS devices_family ON devices (family_id);
CREATE TABLE IF NOT EXISTS usage_months (
  family_id    TEXT NOT NULL,
  month        TEXT NOT NULL,
  turns        INTEGER NOT NULL DEFAULT 0,
  audio_s      INTEGER NOT NULL DEFAULT 0,
  gemini_calls INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (family_id, month)
);
CREATE TABLE IF NOT EXISTS events (ts TEXT, family_id TEXT, kind TEXT, detail TEXT);
`;

function migrate(db) {
  const cols = db.prepare("PRAGMA table_info(families)").all().map((c) => c.name);
  if (!cols.includes("token_hash")) {
    db.exec(SCHEMA);
    db.exec("PRAGMA user_version = 2");
    return;
  }
  // v1 -> v2, in one transaction: rebuild families without token_hash, move tokens to devices.
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("ALTER TABLE families RENAME TO families_v1");
    db.exec(SCHEMA);
    db.exec(`INSERT INTO families (id, label, contact, plan, status, monthly_cap_s, channel, created_at, expires_at)
             SELECT id, label, contact, plan, status, monthly_cap_s, channel, created_at, expires_at FROM families_v1`);
    db.exec(`INSERT INTO devices (token_hash, family_id, via, created_at)
             SELECT token_hash, id, 'legacy', created_at FROM families_v1`);
    const before = db.prepare("SELECT count(*) AS n FROM families_v1").get().n;
    const after = db.prepare("SELECT count(*) AS n FROM families").get().n;
    const devs = db.prepare("SELECT count(*) AS n FROM devices").get().n;
    if (before !== after || devs < before) throw new Error(`migration count mismatch ${before}/${after}/${devs}`);
    db.exec("DROP TABLE families_v1");
    db.exec("PRAGMA user_version = 2");
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function openDb(file) {
  process.umask(0o077); // the -wal/-shm files are created later, by whichever process writes first
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  chmodSync(file, 0o600);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;");
  migrate(db);
  return db;
}

export const sha256Hex = (s) => createHash("sha256").update(s).digest("hex");
export const newDeviceToken = () => randomBytes(32).toString("base64url");

// Months roll over at midnight IST: every family is in India.
export function monthKey(t = Date.now()) {
  return new Date(t + 5.5 * 3600_000).toISOString().slice(0, 7);
}

// The interface src/worker.js expects as env.ENTITLEMENTS.
export function createStore(db) {
  const byDevice = db.prepare(`
    SELECT f.* FROM devices d JOIN families f ON f.id = d.family_id
    WHERE d.token_hash = ? AND d.revoked_at IS NULL`);
  const seen = db.prepare("UPDATE devices SET last_seen_at = ? WHERE token_hash = ?");
  const byEmail = db.prepare("SELECT * FROM families WHERE email = ?");
  const bindSub = db.prepare("UPDATE families SET google_sub = ? WHERE id = ? AND google_sub IS NULL");
  const addDevice = db.prepare("INSERT INTO devices (token_hash, family_id, via, created_at) VALUES (?, ?, 'google', ?)");
  const usageQ = db.prepare("SELECT turns, audio_s, gemini_calls FROM usage_months WHERE family_id = ? AND month = ?");
  const bump = db.prepare(`
    INSERT INTO usage_months (family_id, month, turns, audio_s, gemini_calls) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (family_id, month) DO UPDATE SET
      turns = turns + excluded.turns,
      audio_s = audio_s + excluded.audio_s,
      gemini_calls = gemini_calls + excluded.gemini_calls`);
  const logEvent = db.prepare("INSERT INTO events (ts, family_id, kind, detail) VALUES (?, ?, ?, ?)");
  const recent = new Map(); // family id -> timestamps of turns in the last minute
  // Google sign-ins in flight, keyed by sha256(client secret). In memory on purpose: the raw
  // device token waits here for pickup (<= 10 min) and never touches disk. A restart just
  // means the parent taps "Sign in" again.
  const logins = new Map();
  const event = (familyId, kind, detail = {}) =>
    logEvent.run(new Date().toISOString(), familyId, kind, JSON.stringify(detail));
  const sweep = (now) => { for (const [k, v] of logins) if (now - v.at > LOGIN_TTL_MS) logins.delete(k); };

  return {
    lookup(tokenHash) {
      const f = byDevice.get(tokenHash) || null;
      if (f) seen.run(new Date().toISOString(), tokenHash);
      return f;
    },
    usage: (familyId) => usageQ.get(familyId, monthKey()) || { turns: 0, audio_s: 0, gemini_calls: 0 },
    // Sliding one-minute window, in memory (resets on restart, which is fine for a bill guard).
    allowTurn(familyId, now = Date.now()) {
      const ts = (recent.get(familyId) || []).filter((t) => now - t < 60_000);
      const ok = ts.length < RATE_PER_MIN;
      if (ok) ts.push(now);
      recent.set(familyId, ts);
      return ok;
    },
    record(familyId, { turns = 0, audio_s = 0, gemini_calls = 0 }) {
      bump.run(familyId, monthKey(), turns, audio_s, gemini_calls);
    },
    event,

    // --- Google sign-in ---
    beginLogin(stateHash, now = Date.now()) {
      sweep(now);
      if (logins.size >= MAX_PENDING_LOGINS) return false;
      if (!logins.has(stateHash)) logins.set(stateHash, { at: now });
      return true;
    },
    hasLogin: (stateHash) => logins.has(stateHash),
    failLogin(stateHash, error) {
      const l = logins.get(stateHash);
      if (l) l.error = error;
    },
    // Verified Google identity -> a new device token for the invited family, or an error code.
    completeLogin(stateHash, { email, sub }) {
      const l = logins.get(stateHash);
      if (!l) return { error: "expired" };
      const f = byEmail.get(email.toLowerCase());
      if (!f) { l.error = "not_invited"; return { error: "not_invited" }; }
      bindSub.run(sub, f.id);
      if (byEmail.get(email.toLowerCase()).google_sub !== sub) {
        l.error = "wrong_account";
        event(f.id, "login_refused", { reason: "google_sub mismatch" });
        return { error: "wrong_account" };
      }
      const token = newDeviceToken();
      addDevice.run(sha256Hex(token), f.id, new Date().toISOString());
      event(f.id, "login", { via: "google" });
      l.token = token; l.email = f.email;
      return { email: f.email };
    },
    // One-time pickup by the device holding the secret whose hash started the login.
    pollLogin(stateHash) {
      const l = logins.get(stateHash);
      if (!l) return { status: "unknown" };
      if (l.token) { logins.delete(stateHash); return { status: "done", token: l.token, email: l.email }; }
      if (l.error) { logins.delete(stateHash); return { status: "error", error: l.error }; }
      return { status: "pending" };
    },
  };
}
