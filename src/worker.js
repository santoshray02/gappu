// Gappu server: keeps the Gemini API key off the iPad and owns the safety rules.
// Secrets (set with `npx wrangler secret put NAME`):
//   GEMINI_API_KEY  - from https://aistudio.google.com/apikey (use a PAID-tier key)
//   APP_TOKEN       - any long random password; you type it once on the iPad
// Optional variable: GEMINI_MODEL (default gemini-3.1-flash-lite)
//
// Two auth modes, chosen by env:
//   env.ENTITLEMENTS set (self-hosted, server.js + SQLite): per-family tokens with plan,
//     status, expiry, monthly audio cap and a rate limit. APP_TOKEN is not used.
//   otherwise (Cloudflare): the single APP_TOKEN, no limits.
// Parents sign in with Google (self-hosted only): GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET.

const MODEL_DEFAULT = "gemini-3.1-flash-lite";
const MAX_AUDIO_B64 = 2_000_000; // about 1.5 MB of WAV, roughly 45 s at 16 kHz
const MOODS = ["happy", "curious", "calm", "silly", "caring"];
const WAV_BYTES_PER_S = 32000; // the only accepted format: 16 kHz, mono, 16-bit PCM

const SCHEMA = {
  type: "OBJECT",
  properties: {
    heard: { type: "STRING" },
    reply: { type: "STRING" },
    lang: { type: "STRING", enum: ["hi", "en"] },
    mood: { type: "STRING", enum: MOODS },
    new_facts: { type: "ARRAY", items: { type: "STRING" } },
    parent_alert: { type: "BOOLEAN" },
  },
  required: ["heard", "reply", "lang", "mood", "new_facts", "parent_alert"],
  propertyOrdering: ["heard", "reply", "lang", "mood", "new_facts", "parent_alert"],
};

const SAFETY = [
  "HARM_CATEGORY_HARASSMENT",
  "HARM_CATEGORY_HATE_SPEECH",
  "HARM_CATEGORY_SEXUALLY_EXPLICIT",
  "HARM_CATEGORY_DANGEROUS_CONTENT",
].map((category) => ({ category, threshold: "BLOCK_LOW_AND_ABOVE" }));

// Facts matching this are never saved to memory.
const BLOCKED_FACT = /\d{3,}|@|school|address|street|road|colony|sector|phone|mobile|surname|password|स्कूल|पता|फ़ोन|फोन/i;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/chat") {
      if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
      return handleChat(request, env);
    }
    if (url.pathname.startsWith("/auth/google/")) return handleGoogle(request, env, url);
    if (url.pathname === "/api/consent") {
      if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
      return handleConsent(request, env);
    }
    if (url.pathname === "/api/me") {
      if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
      return handleMe(request, env);
    }
    return env.ASSETS.fetch(request);
  },
};

// The one place a token becomes a family. Phase 2 swaps the body for shell-JWT verification.
// Returns { family } (null in single-token mode) or { error: Response }. Fails closed.
async function resolveFamily(request, env) {
  const token = (request.headers.get("x-app-token") || "").trim();
  const store = env.ENTITLEMENTS;
  if (!store) {
    if (!env.APP_TOKEN || !token || token !== env.APP_TOKEN) return { error: json({ error: "Unauthorized" }, 401) };
    return { family: null };
  }
  const family = token ? await store.lookup(await sha256Hex(token)) : null;
  if (!family) return { error: json({ error: "Unauthorized" }, 401) };
  return { family };
}

// Why this family may not talk right now, as a Response, or null if it may.
async function entitlementError(family, env) {
  if (!family) return null;
  const expired = family.expires_at && !(Date.parse(family.expires_at) > Date.now());
  if (family.status !== "active" || expired) return json({ error: "subscription" }, 402);
  const used = await env.ENTITLEMENTS.usage(family.id);
  if (used.audio_s >= family.monthly_cap_s) return json({ error: "cap" }, 429);
  return null;
}

async function handleMe(request, env) {
  if (!env.ENTITLEMENTS) return json({ error: "No subscriptions on this server" }, 404);
  const { family, error } = await resolveFamily(request, env);
  if (error) return error;
  const used = await env.ENTITLEMENTS.usage(family.id);
  return json({
    email: family.email || null,
    plan: family.plan,
    status: family.status,
    expires_at: family.expires_at,
    used_s: used.audio_s,
    cap_s: family.monthly_cap_s,
  });
}

// ---------- Sign in with Google ----------
// Server-side authorization-code flow instead of Google's popup/FedCM button, because a popup
// can't open in an iOS Home Screen app. The iPad keeps a random secret S and sends only
// sha256(S) as the OAuth state; whichever browser Google returns to (the Home Screen app, an
// in-app browser, the parent's phone) completes the login, and the iPad collects its device
// token by proving it holds S (POST /auth/google/poll). S never appears in a URL or a log.
const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const STATE_RE = /^[0-9a-f]{64}$/;

async function handleGoogle(request, env, url) {
  const store = env.ENTITLEMENTS;
  const enabled = !!(store && env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
  if (url.pathname === "/auth/google/status") return json({ enabled });
  if (!enabled) return json({ error: "Google sign-in is not configured" }, 404);
  const redirectUri = `${url.origin}/auth/google/callback`;
  const step = url.pathname.slice("/auth/google/".length);

  if (step === "start" && request.method === "GET") {
    const state = url.searchParams.get("s") || "";
    if (!STATE_RE.test(state)) return page("That sign-in link is broken. Go back to Gappu and tap Sign in again.", 400);
    if (!(await store.beginLogin(state))) return page("Too many sign-ins right now. Try again in a few minutes.", 503);
    const q = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID, redirect_uri: redirectUri, response_type: "code",
      scope: "openid email", state, prompt: "select_account",
    });
    return new Response(null, { status: 302, headers: { location: `${env.GOOGLE_AUTH_URL || GOOGLE_AUTH}?${q}`, "cache-control": "no-store" } });
  }

  if (step === "callback" && request.method === "GET") {
    const state = url.searchParams.get("state") || "";
    if (!STATE_RE.test(state) || !(await store.hasLogin(state))) {
      return page("This sign-in has expired. Go back to Gappu and tap Sign in again.", 400);
    }
    const code = url.searchParams.get("code");
    if (!code) { await store.failLogin(state, "cancelled"); return page("Sign-in was cancelled. Go back to Gappu to try again.", 400); }
    const id = await googleIdentity(code, redirectUri, env);
    if (!id) { await store.failLogin(state, "google_error"); return page("Google sign-in didn't work. Go back to Gappu and try again.", 502); }
    const r = await store.completeLogin(state, id);
    if (r.error === "not_invited") return page(`${id.email} isn't invited to Gappu yet. Sign in with the Gmail address you gave us, or ask us to add this one.`, 403);
    if (r.error === "wrong_account") return page("This email is linked to a different Google account. Please contact us.", 403);
    if (r.error) return page("This sign-in has expired. Go back to Gappu and tap Sign in again.", 400);
    return page(`Signed in as ${r.email}. Go back to Gappu to finish setting up.`, 200, true);
  }

  if (step === "poll" && request.method === "POST") {
    let body;
    try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
    const secret = typeof body.secret === "string" ? body.secret : "";
    if (!/^[0-9a-f]{64}$/.test(secret)) return json({ error: "Bad secret" }, 400);
    const r = await store.pollLogin(await sha256Hex(secret));
    if (r.status === "done") return json({ token: r.token, email: r.email });
    if (r.status === "pending") return json({ pending: true }, 202);
    if (r.status === "error") return json({ error: r.error }, 403);
    return json({ error: "expired" }, 404);
  }
  return json({ error: "Not found" }, 404);
}

// Exchanges the code for an ID token. The token comes straight from Google's token endpoint
// over TLS in exchange for our client secret, so per OIDC Core 3.1.3.7 its signature needn't be
// re-verified; the claims still are. Returns { email, sub } or null.
async function googleIdentity(code, redirectUri, env) {
  try {
    const res = await fetch(env.GOOGLE_TOKEN_URL || GOOGLE_TOKEN, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri, grant_type: "authorization_code",
      }),
    });
    if (!res.ok) { console.error("google token exchange", res.status, (await res.text()).slice(0, 200)); return null; }
    const { id_token } = await res.json();
    const c = JSON.parse(new TextDecoder().decode(b64urlBytes(String(id_token).split(".")[1])));
    const ok = c.aud === env.GOOGLE_CLIENT_ID &&
      (c.iss === "https://accounts.google.com" || c.iss === "accounts.google.com") &&
      c.exp * 1000 > Date.now() && c.email_verified === true &&
      typeof c.email === "string" && typeof c.sub === "string";
    if (!ok) { console.error("google id_token claims rejected"); return null; }
    return { email: c.email.toLowerCase(), sub: c.sub };
  } catch (e) {
    console.error("google identity", e);
    return null;
  }
}

function b64urlBytes(s) {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(b, (ch) => ch.charCodeAt(0));
}

// A tiny grown-up page for the end of the Google round trip. If this is the same app that
// started the sign-in (its pending secret is in localStorage), go straight back into it.
function page(message, status, success = false) {
  const esc = message.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
  const back = success
    ? `<script>try{if(localStorage.getItem("gappu:login"))location.replace("/")}catch(e){}</script>`
    : "";
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Gappu</title><style>body{font:18px/1.5 system-ui,sans-serif;color:#2A1E5C;background:#FFF9EE;margin:0;display:grid;place-items:center;min-height:100vh}
main{max-width:420px;padding:24px}a{display:inline-block;margin-top:16px;padding:12px 20px;border-radius:12px;background:#2A1E5C;color:#fff;text-decoration:none;font-weight:700}</style>
<main><p>${esc}</p><a href="/">Open Gappu</a></main>${back}`, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });
}

// Records that a parent accepted consent text version X on setup. Evidence for the
// fiduciary; stores the version string only, nothing about the child.
async function handleConsent(request, env) {
  if (!env.ENTITLEMENTS) return json({ error: "No subscriptions on this server" }, 404);
  const { family, error } = await resolveFamily(request, env);
  if (error) return error;
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const version = clean(body && body.version, 20);
  if (!/^\d{4}-\d\d-\d\d$/.test(version)) return json({ error: "Bad version" }, 400);
  await env.ENTITLEMENTS.event(family.id, "consent", { version });
  return json({ ok: true });
}

async function handleChat(request, env) {
  const { family, error } = await resolveFamily(request, env);
  if (error) return error;
  const denied = await entitlementError(family, env);
  if (denied) return denied;
  if (!env.GEMINI_API_KEY) return json({ error: "Server is missing GEMINI_API_KEY" }, 500);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const audio = typeof body.audio === "string" ? body.audio : "";
  if (!audio || audio.length > MAX_AUDIO_B64) return json({ error: "Audio missing or too long" }, 400);
  const audioSeconds = wavSeconds(audio);
  if (!audioSeconds) return json({ error: "Audio must be 16 kHz mono 16-bit WAV" }, 400);

  if (family && !(await env.ENTITLEMENTS.allowTurn(family.id))) return json({ error: "rate" }, 429);
  // Counted whether or not Gemini succeeds: a failing call still costs money.
  const stats = { calls: 0 };
  try {
    return await converse(body, audio, env, stats);
  } finally {
    if (family) await env.ENTITLEMENTS.record(family.id, { turns: 1, audio_s: audioSeconds, gemini_calls: stats.calls });
  }
}

async function converse(body, audio, env, stats) {

  const profile = cleanProfile(body.profile);
  const memories = (Array.isArray(body.memories) ? body.memories : [])
    .slice(-40)
    .map((m) => clean(m, 120))
    .filter(Boolean);

  // Previous turns go in as text; only the current turn is audio.
  const contents = [];
  for (const h of (Array.isArray(body.history) ? body.history : []).slice(-8)) {
    const heard = clean(h && h.heard, 300);
    const reply = clean(h && h.reply, 400);
    if (heard && reply) {
      contents.push({ role: "user", parts: [{ text: heard }] });
      contents.push({ role: "model", parts: [{ text: reply }] });
    }
  }
  contents.push({
    role: "user",
    parts: [
      { inlineData: { mimeType: "audio/wav", data: audio } },
      { text: `${profile.childName} just spoke (audio above). Reply as ${profile.companionName}, following all the rules, as JSON. If replying in Hindi, the reply must be entirely in Devanagari script.` },
    ],
  });

  const payload = {
    systemInstruction: { parts: [{ text: systemPrompt(profile, memories) }] },
    contents,
    generationConfig: {
      temperature: 0.8,
      maxOutputTokens: 500,
      responseMimeType: "application/json",
      responseSchema: SCHEMA,
      thinkingConfig: { thinkingLevel: "minimal" },
    },
    safetySettings: SAFETY,
  };

  const model = env.GEMINI_MODEL || MODEL_DEFAULT;
  let result = await askGemini(model, payload, env.GEMINI_API_KEY, stats);
  if (result.out && romanHindi(result.out)) {
    // The model wrote Hindi in Roman letters; ask once more, pointedly.
    contents.push({ role: "model", parts: [{ text: JSON.stringify(result.out) }] });
    contents.push({
      role: "user",
      parts: [{ text: "That reply is in Roman letters. Rewrite the same reply entirely in Devanagari script (हिंदी अक्षर), same JSON fields." }],
    });
    const retry = await askGemini(model, payload, env.GEMINI_API_KEY, stats);
    if (retry.out && !romanHindi(retry.out)) result = retry;
  }
  if (result.error) return result.error;
  if (result.blocked) return json(fallback(profile));
  if (!result.out) return json(fallback(profile, false));
  return json(sanitizeOut(result.out));
}

// Calls Gemini and parses the structured reply. Returns one of:
// { error: Response } | { blocked: true } | { out: null } (bad JSON) | { out: object }
async function askGemini(model, payload, key, stats) {
  stats.calls++;
  let res = await callGemini(model, payload, key);
  if (res.status === 400) {
    // Some models don't accept thinkingLevel; retry without it.
    delete payload.generationConfig.thinkingConfig;
    stats.calls++;
    res = await callGemini(model, payload, key);
  }
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    return { error: json({ error: "Gemini error", status: res.status, detail }, 502) };
  }

  const data = await res.json();
  const cand = data.candidates && data.candidates[0];
  const blocked =
    !cand ||
    (data.promptFeedback && data.promptFeedback.blockReason) ||
    ["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII"].includes(cand.finishReason);
  if (blocked) return { blocked: true };

  const text = ((cand.content && cand.content.parts) || [])
    .filter((p) => !p.thought)
    .map((p) => p.text || "")
    .join("");
  try {
    return { out: JSON.parse(text) };
  } catch {
    return { out: null };
  }
}

function systemPrompt(p, memories) {
  const mem = memories.length ? memories.map((m) => `- ${m}`).join("\n") : "- (nothing yet)";
  return `You are ${p.companionName}, a cheerful, gentle baby elephant who is a pretend friend for ${p.childName}, a ${p.age}-year-old boy in India. You talk through an iPad. He cannot read yet, so everything you write is spoken aloud.

HOW TO TALK
- Keep replies very short: 1 to 3 short sentences, under 35 words. Use simple words a ${p.age}-year-old knows.
- Be warm, playful and encouraging, like a kind older cousin. Use his name sometimes, not every time.
- He speaks ${p.languages}. Reply in the language he used. For Hindi or Hinglish, write the WHOLE reply in Devanagari script (देवनागरी), never in Roman letters, because a Hindi voice reads it aloud and cannot read "mujhe" or "kahani". Write English words like "dinosaur" in Devanagari too (डायनासोर). Set lang to "hi". For English, use simple Indian English in Latin letters and set lang to "en".
- Ask at most one simple question back. Often suggest something to do away from the screen: draw it, find it at home, show Mummy or Papa, play pretend.
- No emojis, lists, or special symbols, because the reply is read aloud.

BEING TRUTHFUL
- Give correct, simple facts. If you are not sure, say so and suggest asking Mummy or Papa together.
- If he asks whether you are real, say kindly that you are a pretend elephant friend who lives in the iPad, a talking computer, not a real animal or person.
- Never pretend to see him, touch him, or be in the room with him.

SAFETY (most important)
- Nothing scary, violent, rude, romantic, or grown-up. Stories are gentle with happy endings.
- Never explain how to use or reach dangerous things: knives, scissors, fire, matches, gas, electricity or plugs, medicines, cleaning liquids, windows, balconies, stairs, roads, deep water, or going out alone. Say that is a grown-up job and to ask Mummy or Papa.
- If he says he is hurt, sick, scared, sad or lost, or that someone hurt him, touched him in a way he didn't like, or asked him to keep a secret: be calm and kind, tell him to go to Mummy, Papa or a trusted grown-up right now, and set parent_alert to true.
- You never keep secrets from Mummy and Papa. If he asks you to, gently say friends can tell Mummy and Papa everything.
- Never ask for his full name, address, school, phone number or photos. If he says them, don't repeat them.
- Don't take sides in family arguments or say anything bad about anyone.
- If the audio has no clear speech, set heard to "" and ask him to say it again.

MEMORY
Things you remember about ${p.childName} (use them naturally, never list them):
${mem}
In new_facts, add at most 1 or 2 short, harmless things worth remembering from THIS turn only, written in English (for example "Loves red trucks", "Has a toy called Bholu"). Usually leave it empty. Never store surnames, addresses, school names, phone numbers, health details, or anything about family problems.

OUTPUT
Return JSON only: heard (what ${p.childName} said, in the script he used), reply, lang ("hi" or "en"), mood (happy, curious, calm, silly or caring), new_facts, parent_alert.`;
}

function callGemini(model, payload, key) {
  return fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify(payload),
  });
}

// Whole seconds of audio in a base64 WAV, or 0 if it isn't 16 kHz mono 16-bit PCM.
// Duration comes from the byte count, never the header's byteRate, so a forged header
// can't make a long clip look short and slip under the monthly cap.
function wavSeconds(b64) {
  let h;
  try { h = atob(b64.slice(0, 48)); } catch { return 0; }
  const u16 = (o) => h.charCodeAt(o) | (h.charCodeAt(o + 1) << 8);
  const u32 = (o) => (u16(o) + u16(o + 2) * 65536);
  const ok = h.length >= 36 && h.slice(0, 4) === "RIFF" && h.slice(8, 16) === "WAVEfmt " &&
    u16(20) === 1 && u16(22) === 1 && u32(24) === 16000 && u16(34) === 16;
  if (!ok) return 0;
  const bytes = Math.floor((b64.length * 3) / 4) - 44;
  return Math.max(1, Math.ceil(bytes / WAV_BYTES_PER_S));
}

async function sha256Hex(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const DEVANAGARI = /[ऀ-ॿ]/;

// A "hi" reply with no Devanagari at all would be read letter-by-letter by the Hindi voice.
function romanHindi(o) {
  return o && o.lang !== "en" && typeof o.reply === "string" && !DEVANAGARI.test(o.reply);
}

function sanitizeOut(o) {
  return {
    heard: clean(o.heard, 300),
    reply: clean(o.reply, 400) || "...",
    lang: o.lang === "en" ? "en" : "hi",
    mood: MOODS.includes(o.mood) ? o.mood : "happy",
    new_facts: (Array.isArray(o.new_facts) ? o.new_facts : [])
      .map((f) => clean(f, 120))
      .filter((f) => f && !BLOCKED_FACT.test(f))
      .slice(0, 2),
    parent_alert: o.parent_alert === true,
  };
}

// Used when Gemini's safety filter blocks a reply (alert = true) or the output is broken.
function fallback(p, alert = true) {
  const english = /mostly english/i.test(p.languages);
  return {
    heard: alert ? "(reply blocked by safety filter)" : "",
    reply: english
      ? "Let's talk about something else! What's your favourite animal?"
      : "चलो, कुछ और बात करते हैं! तुम्हें कौन सा जानवर सबसे अच्छा लगता है?",
    lang: english ? "en" : "hi",
    mood: "calm",
    new_facts: [],
    parent_alert: alert,
  };
}

function cleanProfile(p) {
  p = p && typeof p === "object" ? p : {};
  const age = parseInt(p.age, 10);
  return {
    childName: clean(p.childName, 30) || "Tosu",
    age: age >= 2 && age <= 12 ? age : 4,
    languages: clean(p.languages, 60) || "Hindi and English (Hinglish)",
    companionName: clean(p.companionName, 30) || "Gappu",
  };
}

function clean(s, max) {
  return String(s == null ? "" : s)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, max);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
