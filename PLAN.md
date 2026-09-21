# Gappu as a subscription — plan of record

**Status:** Phase 1 built and live 2026-09-21 (entitlement layer, `/api/me`, admin CLI, spoken lines, nightly backup). Deviations: no 60 s cache (SQLite lookups are direct, so revoke is instant); ids are `fam_<hex>` not ulid; tokens are `xxxxx-xxxxx-xxxxx-xxxxx`. Phase 0, M2+ not started.
**Owner:** Xentovia (XV). EdunodeX is a sales channel, not the host.

## Decision

Gappu stays a **standalone service under the Xentovia brand** with its own tiny entitlement
layer. It does **not** move into EdunodeX's per-school tenancy and does **not** (yet) become an
XV shell tenant app. Reasons, in order:

1. **Tenant shape.** EdunodeX's tenant is a school; XV's is a business org with members, zones
   and RBAC. Gappu's tenant is a *family with one token*, and all conversation state lives on
   the iPad. Neither model fits without carrying dead weight.
2. **Blast radius.** Both platforms are live prod for paying customers. The XV shell is "the one
   component every tenant shares" (`docs/reference/shell-boundary.md`); EdunodeX's Caddy/backend
   already blocked us once today (`check-domain` allowlist). Gappu must deploy in 30 seconds
   without either platform noticing.
3. **Compliance separation.** Children's voice data under DPDP is its own risk category. A
   separate product with its own privacy policy, consent flow and retention story is simpler to
   defend than "it's a module of the school system".
4. **Sequencing.** Zero paying families today. Build the smallest thing that can take money,
   then graduate to shell-issued keys when there is a reason to (see Phase 2 trigger).

## Phase 0 — before any money changes hands (legal, 1–2 weeks, not engineering)

- [ ] Lawyer review: **DPDP Act 2023** verifiable-parental-consent flow, no behavioural
      tracking of children, retention statement, grievance officer.
- [x] ~~Confirm Gemini terms for a **child-directed** product. Expectation: move to Vertex AI.~~
      **Falsified 2026-09-21.** Both forbid it: Gemini API terms (ai.google.dev/gemini-api/terms,
      updated 2026-04-28, "Age Requirements") and Google Cloud Service Specific Terms (modified
      2026-09-16, "Generative AI Services" §(d)): no app "directed towards or … likely to be accessed
      by individuals under the age of 18"; §(f) allows immediate suspension. Gemini (any endpoint,
      incl. Live API) must be replaced before any paid launch. Anthropic's API permits
      minors-facing products with safeguards (support.claude.com article 9307344); Sarvam permits
      under-18 use with verifiable parental consent and is India-resident. See HANDOFF "LLM stack".
- [ ] Terms of service: "pretend friend, not supervision", safety-incident process, refund policy.
- [ ] Decide the legal seller entity and GST treatment (Xentovia).

## Phase 1 — standalone entitlement layer (engineering, ~1 day)

Goal: many families, each with its own token, plan, status and monthly cap; one leaked token
cannot run up the Gemini bill; nothing in EdunodeX or XV changes.

### Data

One SQLite file on the host (`~/projects/gappu/data/gappu.db`, mode 600, nightly copy into
`~/backups`). Postgres is overkill until Phase 2.

```sql
CREATE TABLE families (
  id            TEXT PRIMARY KEY,           -- ulid
  label         TEXT NOT NULL,              -- "Tosu's family" — no child full names, ever
  contact       TEXT NOT NULL,              -- parent phone or email, for support/billing only
  plan          TEXT NOT NULL DEFAULT 'trial',   -- trial | monthly | yearly | channel_school
  status        TEXT NOT NULL DEFAULT 'active',  -- active | past_due | cancelled
  token_hash    TEXT NOT NULL UNIQUE,       -- sha256 of the iPad token; raw token shown once
  monthly_cap_s INTEGER NOT NULL DEFAULT 54000,  -- 30 min/day * 30
  channel       TEXT,                       -- NULL | 'edunodex:<school_code>'
  created_at    TEXT NOT NULL, expires_at TEXT
);
CREATE TABLE usage_months (
  family_id TEXT NOT NULL, month TEXT NOT NULL,  -- '2026-09'
  turns INTEGER NOT NULL DEFAULT 0, audio_s INTEGER NOT NULL DEFAULT 0,
  gemini_calls INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (family_id, month)
);
CREATE TABLE events (                       -- provisioning/billing audit only, never content
  ts TEXT, family_id TEXT, kind TEXT, detail TEXT
);
```

**Never stored server-side:** audio, `heard`, `reply`, memories, `parent_alert` content. Only
counts. This is the whole privacy pitch and must survive every later change.

### Request path (`src/worker.js` + `server.js`)

1. `x-app-token` → sha256 → `families` lookup (in-memory cache, 60 s TTL, fail closed).
2. Reject unless `status = 'active'` and `expires_at` in the future → `402 {error:"subscription"}`.
3. Reject if this month's `audio_s >= monthly_cap_s` → `429 {error:"cap"}`.
4. Per-token rate limit: 20 turns / minute (token-bucket in memory).
5. Forward to Gemini as today; on success increment `usage_months`.

The iPad gets two new spoken lines (`LINES.subscription`, `LINES.cap`) so Tosu hears
"ask Mummy or Papa" instead of "my brain took a nap", and the parent panel shows the plan
state and days left (from a new `GET /api/me` that returns `{plan, status, expires_at, used_s,
cap_s}` — no PII).

The token check is behind one function, `resolveFamily(token)`, so Phase 2 can swap it for a
JWKS-verified shell key without touching the rest.

### Provisioning

A small admin CLI on the host, no web UI yet:

```
gappu-admin create --label "Tosu's family" --contact +91… --plan monthly [--channel edunodex:stfes]
gappu-admin renew <id> --months 1
gappu-admin suspend|resume|revoke <id>
gappu-admin usage [<id>|--month 2026-09]
```

`create` prints the raw token once. Parents type it on the setup screen exactly as today.

### Billing (no code in Phase 1)

Razorpay **Subscription Links** (hosted page, no integration code) → webhook `POST
/api/billing/razorpay` (signature-verified) → `renew`/`past_due`. Until the webhook exists,
`gappu-admin renew` by hand is acceptable for the pilot. EdunodeX's existing Razorpay account
can be reused only if Xentovia is the seller of record; otherwise open one for Xentovia.

Pricing to test: **₹349/month, ₹2,999/year**, 14-day trial. Floor cost ≈ ₹100–200/child/month
Gemini + ~₹0 hosting, so gross margin ≥ 45% at the monthly price.

### Ops

- `journalctl -u gappu` → add an uptime check (any HTTP monitor) on `GET /` and a daily
  Gemini-spend alert in Google Cloud Billing.
- `gappu.service` already restarts on failure; keep it, add `LimitNOFILE` and a log rotate.
- Secrets stay in `~/projects/gappu/.env`. Rotate `GEMINI_API_KEY` when moving to Vertex.

## Phase 1b — EdunodeX as a channel (thin API, ~half a day, EdunodeX side is their call)

Gappu exposes a channel API, authenticated by a static bearer per channel:

```
POST   /api/channel/families        {label, contact, school_code}  → {id, token, setup_url}
DELETE /api/channel/families/{id}
GET    /api/channel/families?school_code=…                        → [{id, label, status, expires_at}]
```

EdunodeX (if/when it wants to) calls this from its own parent app and bills the family on the
school invoice as an add-on. Gappu never reads EdunodeX's database; EdunodeX never sees a
conversation. The same API serves a preschool chain or a direct-to-consumer signup page later.

## Phase 2 — graduate to the XV shell (only when triggered)

**Trigger:** any of — more than ~50 paying families; a second consumer product needs the same
accounts/keys; a channel partner needs self-serve admin; or Xentovia consolidates billing.

Then, following the voice-console pattern (`apps/voice-console/api/auth/verifier.py`):

- Family = **org** on plan `gappu_family` with a single member (the parent).
- iPad token = **shell-issued RS256 API key** with scope `gappu:chat` gated on zone `gappu`
  (one line in `apps/web/api/routes/api_keys.py::_SCOPE_REQUIRED_ZONE`, plus
  `plan_entitlements` rows for `gappu_family`: zone `gappu`, limit `gappu.minutes_per_month`).
- `resolveFamily()` becomes "verify JWT against the shell JWKS + revocation snapshot, read
  `zones`/limits from the claims"; the SQLite `families` table goes away, `usage_months` stays
  (or moves to LiteLLM spend if the LLM call moves behind the proxy — see risk below).
- Gappu becomes `/api/gappu/*` in Caddy under `app.xentovia.ai` or keeps its own host; either
  is fine by the shell-boundary rule as long as the shell never relays it.

This is a data + one-scope change in the shell, but it lands in live prod and goes through XV's
normal process (spec in `docs/specs/`, migration via `./manage.sh migrate`, reviewers). Do not
start it before the trigger.

## Known risks / things to verify before relying on them

- **LiteLLM parity.** Gappu depends on Gemini `inlineData` audio, `responseSchema`,
  `safetySettings` and `thinkingConfig`. Whether the LiteLLM proxy passes all four through
  unchanged is unverified. Keep the direct Gemini/Vertex call until a spike proves parity;
  do not make "all LLM calls go through LiteLLM" a Phase 1 requirement for Gappu.
- **Vertex AI audio + structured output** on `gemini-3.1-flash-lite` — verify the same request
  body works before switching keys.
- **Onboarding friction** is the real conversion risk, not tech: Add to Home Screen, mic
  permission, Enhanced Lekha download, Guided Access. Build an in-app setup wizard with the
  consent screen before charging strangers; for the school pilot, do it in person.
- **Safety incidents will happen.** Log counts, keep the parent-side log as the evidence
  source, write the response playbook (who answers, within what time, what gets refunded).

## Milestones

| # | What | Done when |
|---|---|---|
| M0 | Legal review + Vertex switch | Lawyer sign-off; `GEMINI_API_KEY` is a Vertex credential |
| M1 | Entitlement layer + admin CLI | 3 families provisioned by CLI; a revoked token gets 402 on the iPad with the right spoken line |
| M2 | Setup wizard + consent screen in the app | A parent completes setup in < 3 minutes without the README |
| M3 | School pilot via EdunodeX channel API | 20–30 families at one EdunodeX school, free for 30 days |
| M4 | Razorpay subscription webhook | First self-renewing paid family |
| P2 | Shell graduation | Only on trigger above |
