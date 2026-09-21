# Handoff — Gappu

Written 2026-09-21; updated the same day after PLAN Phase 1 (entitlement layer) went live. Development continues **on the server**
(`ssh e2en-edutrack`, `~/projects/gappu`, a git checkout of `github.com/santoshray02/gappu`).
Read `CLAUDE.md` for architecture and `PLAN.md` for the roadmap; this file is only "where things
stand and what to do next".

## Where things stand

| Thing | State |
|---|---|
| Product | Working end-to-end. Child taps → audio → `/api/chat` → Gemini 3.1 Flash-Lite → Devanagari/English reply spoken by the device. |
| Production | **https://gappu.in1.xentovia.ai** — `gappu.service` (systemd, Node 18, `server.js`) bound to `172.18.0.1:10800`, fronted by the shared `edx2_caddy` container via `~/projects/edunodex/extra-sites/gappu.caddy`. Let's Encrypt cert, auto-renews. |
| Secrets | `~/projects/gappu/.env` (mode 600, untracked): `GEMINI_API_KEY` (AI Studio key, **free/paid tier unverified — check billing is on before Tosu uses it daily**), `APP_TOKEN`, `PORT`, `HOST`. The current app token is in that file; it is what parents type on the iPad setup screen. |
| Cloudflare path | Still works from the same repo (`npx wrangler deploy`) but is **not** deployed anywhere. `wrangler.toml` is kept for that option. |
| Client | `public/index.html` v2: scene (sun/moon/stars/clouds/flowers/butterfly), time-of-day sky, mood expressions, live mic level, sleepy-before-nap, sound cues, PWA (manifest, icons, `sw.js`). Verified in desktop Chrome, all states, zero console errors. **Not yet verified on a real iPad.** |
| Server | `src/worker.js`: Devanagari enforcement (stronger prompt + `romanHindi()` one-shot retry); Gemini call factored into `askGemini()`. |
| Entitlements | **Live.** `data/gappu.db` (SQLite via `node:sqlite`), per-family tokens, 402/429 policy, `/api/me`, Subscription card in the parent panel, `bin/gappu-admin.js`. Tosu's existing `APP_TOKEN` was adopted as family `fam_324b9b008e` ("Tosu's family", monthly, no expiry, 900 min cap), so the iPad needed no change. Service now runs nvm Node 22.23.2. Nightly backup cron 21:15 UTC → `~/backups/gappu/`. |
| Tests | None automated. Manual: README §5 checklist. Nine English + three Hindi clips were run through the API this session and all passed (safety refusals, `parent_alert` on "I fell down", no PII stored, Devanagari replies). |
| Local dev | `npx wrangler dev` (reads `.dev.vars`) or `node server.js` (reads env). Wrangler does **not** hot-reload `.dev.vars`. Chrome on `localhost` is a secure context so the mic works; laptop TTS voices are robotic — that is the OS, not the app. |

## Verify in 60 seconds

```bash
systemctl is-active gappu && journalctl -u gappu -n 5 --no-pager
curl -s -o /dev/null -w "%{http_code}\n" https://gappu.in1.xentovia.ai/            # 200
curl -s -X POST https://gappu.in1.xentovia.ai/api/chat -d '{}' -H 'content-type: application/json'   # {"error":"Unauthorized"}
# full round trip (16 kHz mono WAV, base64):
TOKEN=$(grep APP_TOKEN .env | cut -d= -f2)
printf '{"audio":"%s","profile":{"childName":"Tosu","age":4,"languages":"Hindi and English (Hinglish)","companionName":"Gappu"}}' "$(base64 -w0 some.wav)" > /tmp/req.json
curl -s -X POST https://gappu.in1.xentovia.ai/api/chat -H "content-type: application/json" -H "x-app-token: $TOKEN" --data-binary @/tmp/req.json
```

Expected shape: `{"heard","reply","lang","mood","new_facts","parent_alert"}`; a Hindi reply must
contain Devanagari.

## Dev loop on the server

```bash
cd ~/projects/gappu
# edit …
sudo systemctl restart gappu        # ~1 s; static files need no restart, worker.js/server.js do
journalctl -u gappu -f              # logs
git add -A && git commit -m "…" && git push
```

Caddy only needs touching if the hostname or upstream port changes:
`docker exec edx2_caddy caddy validate --config /etc/caddy/Caddyfile` then `… caddy reload …`.

## Provisioning a family

```bash
npm run admin -- create --label "Sharma family" --contact +91… --plan trial     # prints token once
npm run admin -- list | usage | renew <id> --months 1 | suspend|resume|revoke|rotate <id>
```

## Next task (in order)

1. **iPad verification** — README §3–5 on the real device: Enhanced Lekha voice, Add to Home
   Screen (new icon), mic permission, Guided Access, the §5 safety checklist by voice. Fix
   anything iOS-specific (`@property` sky fade needs iOS 16.4+; `ScriptProcessorNode` is
   deprecated but works).
   Also on the iPad: hear `LINES.subscription` (suspend the house family, tap, then resume)
   and see the Subscription card. Both were verified only by curl + headless Chrome.
2. **M1 close-out** — provision 3 real families by CLI (PLAN M1 "done when").
3. **Setup wizard + consent screen** in `index.html` (PLAN M2) — do not charge strangers
   before this exists.

Phase 0 (legal, Vertex terms) is not engineering but gates any paid launch; see PLAN.md.

## Gotchas learned this session

- `pkill -f server.js` kills **production** too. Kill scratch servers (`PORT=10899 GAPPU_DB=<tmp>`) by PID.
- `/usr/bin/node` is v18 (no `node:sqlite`); the unit's `ExecStart` pins the nvm v22 binary.
  An `nvm uninstall 22.23.2` would take production down.

- `gappu.in1.edunodex.in` **cannot** get a cert from `extra-sites/`: that wildcard is on-demand
  TLS whose `ask` callback (`backend/app/main.py::caddy_check_domain`) only approves tenants +
  `admin/api/litellm/lms`, and Caddy's automation-policy sort is not transitive so an explicit
  block does not reliably win. Either stay on `*.in1.xentovia.ai` or add `gappu` to that
  allowlist (3 lines + gunicorn HUP). Details in `gappu.caddy`'s header comment.
- The XV platform (`~/projects/experiments/xv-platform`) is live prod with a strict shell
  boundary; do not add Gappu there before PLAN.md's Phase 2 trigger.
- `encodeWav` in `index.html` does box-filter resampling to exactly 16 kHz — keep it; a naive
  decimation was tried and reverted.
- The parent PIN is a SHA-256 of `"gappu:" + pin` in `localStorage['gappu:settings'].pinHash`.
  For browser testing, swap it temporarily and restore; never ask the parent for their PIN.
- Only the nickname goes to Gemini. Keep it that way in every prompt/log change.
- Both this laptop and the server authenticate to GitHub as `santoshray02`.
