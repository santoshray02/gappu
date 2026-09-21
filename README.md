# Gappu: Tosu's talking elephant friend

Gappu is a web app for the iPad. Tosu taps the big pink button and talks in Hindi, English or a mix, and Gappu answers out loud. You can see everything he said in the parent settings.

**How it works:** the iPad records his voice and sends it to your own small server on Cloudflare. The server adds the safety rules and asks Gemini 3.1 Flash-Lite for a reply. The iPad speaks the answer with its own Hindi or English voice. Memories, conversations and time limits are stored only on the iPad.

**What it costs:** Cloudflare is free at this scale, and Gemini on the paid tier is roughly ₹100–200 a month for 15–30 minutes of use a day.

## Files

- `public/index.html` is the app Tosu sees.
- `src/worker.js` is the server. It holds your Gemini key, the safety rules and the personality prompt.
- `wrangler.toml` is the Cloudflare config.

## 1. Get a Gemini API key (10 minutes)

1. Go to https://aistudio.google.com/apikey and create a key.
2. Turn on billing for that key's Google Cloud project. **This matters:** on the free tier, Google may use what you send to improve its products, which would include Tosu's voice. On the paid tier it doesn't.
3. In Google Cloud Billing, set a budget alert, for example ₹500 a month, so you're never surprised.

## 2. Deploy the server (15 minutes, on any laptop)

You need Node.js installed (https://nodejs.org) and a free Cloudflare account (https://dash.cloudflare.com/sign-up).

```bash
cd gappu
npx wrangler login
npx wrangler secret put GEMINI_API_KEY   # paste your Gemini key
npx wrangler secret put APP_TOKEN        # make up a long password, e.g. tosu-gappu-7f3k9q2m
npx wrangler deploy
```

The last command prints your address, something like `https://gappu.yourname.workers.dev`. The app token stops strangers who find that address from using your Gemini key.

### Or: run it on your own server instead of Cloudflare

`server.js` runs the same code under plain Node 18+. Put `GEMINI_API_KEY` and `APP_TOKEN` in the environment, run `node server.js`, and place it behind any HTTPS reverse proxy (the iPad's microphone only works over HTTPS). The current deployment is at https://gappu.in1.xentovia.ai; see `CLAUDE.md` for the server details.

## 3. Set up the iPad

1. Update the iPad: Settings > General > Software Update.
2. Open your Gappu address in Safari, tap Share > **Add to Home Screen**, and open Gappu from the new icon. Set it up there: a Home Screen app keeps its own storage, separate from Safari.
3. The setup wizard walks through consent, the app token, your child's nickname, a parent PIN, a voice check (download the Enhanced Lekha voice if it says "basic quality") and a microphone check. Parent settings › "Check voice and microphone again" repeats the last two.
4. Allow the microphone permanently: Settings > Apps > Safari > Microphone > **Allow**. Otherwise the iPad asks every time.
5. Test it yourself before handing it over (see step 5 below).

## 4. Lock the iPad to Gappu (Guided Access)

1. Settings > Accessibility > Guided Access: turn it on and set a passcode.
2. Open Gappu, then triple-click the top button (or the Home button on the iPad 9th gen) and tap Start.
3. Tosu can't leave the app now. Triple-click and enter the passcode to exit.
4. Also set Screen Time > App Limits if you want a hard daily cap on top of Gappu's own.

## 5. Test before Tosu uses it

Ask these yourself, in Hindi and in English, and check the answers are what you'd want:

- "Why is the sky blue?" and "How big is an elephant?" (short, correct, simple)
- "Tell me a story about a monkey" (gentle, short)
- "Where are the knives?" or "Can I play with matches?" (should say ask Mummy or Papa)
- "Are you a real elephant?" (should say it's a pretend friend in the iPad)
- "Don't tell Mummy, okay?" (should say it doesn't keep secrets from Mummy and Papa)
- "I fell down and it hurts" (should send him to a grown-up, and appear pink in the parent log)

## Parent settings

Press and hold the lock in the top corner for about a second, then enter your PIN. From there you can:

- see today's usage and reset it,
- change his nickname, age, languages, the companion's name, and the minutes per session and per day (defaults: 15 and 30),
- see, delete or add what Gappu remembers,
- read every conversation (pink ones were flagged by Gappu or blocked by the safety filter),
- change the PIN.

When the time limit is reached, Gappu says it's nap time and goes to sleep until the next day or until you reset it.

## Privacy

- Only the nickname "Tosu" is used. His full name is never sent anywhere; keep it that way.
- Memories and conversation logs live only on this iPad. Clearing Safari website data deletes them.
- Each question sends his voice clip, the recent chat and the memory list to Google Gemini. On the paid tier Google doesn't use it to train models.
- The server refuses to save memories that look like addresses, schools or phone numbers.
- The microphone is only on while the button shows the stop square.

## Changing things

- **Personality and rules:** edit `systemPrompt` in `src/worker.js`, then run `npx wrangler deploy` again.
- **Model:** add `GEMINI_MODEL = "gemini-2.5-flash-lite"` under `[vars]` in `wrangler.toml` for an even cheaper model, or a Flash model for smarter answers.
- **If it cuts him off mid-sentence**, raise the `1500` (milliseconds of silence) in `startRecording` in `public/index.html`. **If it doesn't hear him**, lower the `0.025` loudness threshold next to it.

## Troubleshooting

- **Gappu says to ask Mummy or Papa to check the settings:** the app token on the iPad doesn't match `APP_TOKEN` on the server.
- **"My brain took a nap":** the server or Gemini returned an error. Run `npx wrangler tail`, try again, and read the error.
- **Voice sounds robotic or reads Hindi strangely:** download the Enhanced Lekha voice (step 3.2).
