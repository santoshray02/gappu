#!/usr/bin/env bash
# End-to-end smoke test: a scratch server on a temp DB with a mock Gemini, exercising
# every entitlement path. No network, no production data. Exit 0 = all passed.
#
#   tests/smoke.sh            (NODE=/path/to/node to override)
set -uo pipefail
cd "$(dirname "$0")/.."
NODE=${NODE:-/opt/node-24/bin/node}
T=$(mktemp -d)
GPORT=$((20000 + RANDOM % 10000)); SPORT=$((GPORT + 1))
PIDS=()
cleanup() { for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null; done; rm -rf "$T"; }
trap cleanup EXIT

export GAPPU_DB=$T/smoke.db
ADMIN="$NODE --disable-warning=ExperimentalWarning bin/gappu-admin.js"
fail=0
check() { # name expected actual
  if [[ "$3" == "$2"* ]]; then printf '  ok    %-28s %s\n' "$1" "$3"
  else printf '  FAIL  %-28s expected %s, got %s\n' "$1" "$2" "$3"; fail=1; fi
}

# Two 16 kHz mono 16-bit WAVs (3 s valid, 8 kHz invalid) as request bodies.
"$NODE" -e '
const fs = require("fs");
const wav = (rate, secs) => {
  const n = rate * secs, b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write("data", 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(3000 * Math.sin(i / 10)), 44 + i * 2);
  return b.toString("base64");
};
const body = (a) => JSON.stringify({ audio: a, profile: { childName: "Tosu", age: 4 } });
fs.writeFileSync(process.argv[1] + "/ok.json", body(wav(16000, 3)));
fs.writeFileSync(process.argv[1] + "/bad.json", body(wav(8000, 2)));
' "$T"

# Families A (monthly) and B (3-second cap), each with one device token.
$ADMIN create --email a@example.com --label A --plan monthly >/dev/null
$ADMIN create --email b@example.com --label B --cap-min 0.05 >/dev/null
"$NODE" --disable-warning=ExperimentalWarning --input-type=module -e "
import { openDb, sha256Hex } from './src/entitlements.js';
const db = openDb(process.env.GAPPU_DB);
for (const [t, e] of [['smoke-token-a-0123456789', 'a@example.com'], ['smoke-token-b-0123456789', 'b@example.com']])
  db.prepare(\"INSERT INTO devices (token_hash, family_id, via, created_at) SELECT ?, id, 'google', 'now' FROM families WHERE email = ?\").run(sha256Hex(t), e);"
A=smoke-token-a-0123456789; B=smoke-token-b-0123456789
FID_A=$($ADMIN list | awk '/a@example.com/{print $1}')

"$NODE" tests/mock-gemini.mjs "$GPORT" & PIDS+=($!)
GEMINI_BASE_URL=http://127.0.0.1:$GPORT GEMINI_API_KEY=test PORT=$SPORT HOST=127.0.0.1 \
  "$NODE" --disable-warning=ExperimentalWarning server.js >"$T/server.log" 2>&1 & PIDS+=($!)
for _ in $(seq 1 50); do curl -s -o /dev/null "http://127.0.0.1:$SPORT/" && break; sleep 0.1; done

U=http://127.0.0.1:$SPORT
req() { curl -s -o "$T/out" -w '%{http_code}' -H 'content-type: application/json' "$@"; echo " $(head -c 60 "$T/out")"; }

echo "smoke: node $("$NODE" --version), server :$SPORT, mock gemini :$GPORT"
check "GET /"                     "200" "$(curl -s -o /dev/null -w '%{http_code}' $U/)"
check "chat without token"        "401" "$(req -X POST $U/api/chat -d @"$T/ok.json")"
check "chat with bad token"       "401" "$(req -H 'x-app-token: nope-nope-nope-nope' -X POST $U/api/chat -d @"$T/ok.json")"
check "chat A"                    "200" "$(req -H "x-app-token: $A" -X POST $U/api/chat -d @"$T/ok.json")"
check "chat A reply is Devanagari" "200 {\"heard\":\"hello\",\"reply\":\"नमस्ते" "$(req -H "x-app-token: $A" -X POST $U/api/chat -d @"$T/ok.json")"
check "8 kHz WAV rejected"        "400" "$(req -H "x-app-token: $A" -X POST $U/api/chat -d @"$T/bad.json")"
check "GET /api/me"               "200 {\"email\":\"a@example.com\"" "$(req -H "x-app-token: $A" $U/api/me)"
check "POST /api/consent"         "200" "$(req -H "x-app-token: $A" -X POST $U/api/consent -d '{"version":"2026-09-21"}')"
check "consent bad version"       "400" "$(req -H "x-app-token: $A" -X POST $U/api/consent -d '{"version":"x"}')"
req -H "x-app-token: $B" -X POST $U/api/chat -d @"$T/ok.json" >/dev/null
check "B over monthly cap"        "429 {\"error\":\"cap\"}" "$(req -H "x-app-token: $B" -X POST $U/api/chat -d @"$T/ok.json")"
$ADMIN suspend "$FID_A" >/dev/null
check "A suspended"               "402" "$(req -H "x-app-token: $A" -X POST $U/api/chat -d @"$T/ok.json")"
$ADMIN resume "$FID_A" >/dev/null
check "A resumed"                 "200" "$(req -H "x-app-token: $A" -X POST $U/api/chat -d @"$T/ok.json")"
$ADMIN revoke-device "$($ADMIN devices "$FID_A" | awk '{print $1}')" >/dev/null
check "A device revoked"          "401" "$(req -H "x-app-token: $A" $U/api/me)"
check "google status (off)"       "200 {\"enabled\":false}" "$(req $U/auth/google/status)"
check "usage recorded"            "yes" "$( $ADMIN usage | grep -q ' A$' && echo yes || echo no)"

if grep -qiE 'error|exception' "$T/server.log"; then echo "  FAIL  server log has errors:"; sed 's/^/        /' "$T/server.log"; fail=1; fi
[ $fail = 0 ] && echo "smoke: PASS" || echo "smoke: FAIL"
exit $fail
