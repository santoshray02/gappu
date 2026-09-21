// Entitlement store for self-hosting (Node 22+, node:sqlite). Not used on Cloudflare.
// Holds families (token hash, plan, status, cap) and monthly usage counts.
// Never store content here: no audio, no heard/reply, no memories, no alerts. Counts only.
//
// Policy (402/429) lives in src/worker.js::resolveFamily; this file is storage.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

export const PLANS = ["trial", "monthly", "yearly", "channel_school"];
export const STATUSES = ["active", "past_due", "cancelled"];
export const DEFAULT_CAP_S = 54000; // 30 min/day * 30
const RATE_PER_MIN = 20;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS families (
  id            TEXT PRIMARY KEY,
  label         TEXT NOT NULL,
  contact       TEXT NOT NULL,
  plan          TEXT NOT NULL DEFAULT 'trial',
  status        TEXT NOT NULL DEFAULT 'active',
  token_hash    TEXT NOT NULL UNIQUE,
  monthly_cap_s INTEGER NOT NULL DEFAULT ${DEFAULT_CAP_S},
  channel       TEXT,
  created_at    TEXT NOT NULL,
  expires_at    TEXT
);
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

export function openDb(file) {
  process.umask(0o077); // the -wal/-shm files are created later, by whichever process writes first
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  chmodSync(file, 0o600);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;");
  db.exec(SCHEMA);
  return db;
}

export const sha256Hex = (s) => createHash("sha256").update(s).digest("hex");

// Months roll over at midnight IST: every family is in India.
export function monthKey(t = Date.now()) {
  return new Date(t + 5.5 * 3600_000).toISOString().slice(0, 7);
}

// The interface src/worker.js expects as env.ENTITLEMENTS.
export function createStore(db) {
  const byHash = db.prepare("SELECT * FROM families WHERE token_hash = ?");
  const usageQ = db.prepare("SELECT turns, audio_s, gemini_calls FROM usage_months WHERE family_id = ? AND month = ?");
  const bump = db.prepare(`
    INSERT INTO usage_months (family_id, month, turns, audio_s, gemini_calls) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (family_id, month) DO UPDATE SET
      turns = turns + excluded.turns,
      audio_s = audio_s + excluded.audio_s,
      gemini_calls = gemini_calls + excluded.gemini_calls`);
  const recent = new Map(); // family id -> timestamps of turns in the last minute

  return {
    lookup: (tokenHash) => byHash.get(tokenHash) || null,
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
  };
}
