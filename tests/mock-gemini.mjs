// Stand-in for generativelanguage.googleapis.com: every generateContent call gets a valid
// Hindi reply after DELAY_MS. Used by tests/smoke.sh and load tests via GEMINI_BASE_URL.
import http from "node:http";

const port = Number(process.argv[2]) || 10896;
const delay = Number(process.env.DELAY_MS) || 0;
const out = JSON.stringify({
  candidates: [{
    finishReason: "STOP",
    content: { parts: [{ text: JSON.stringify({ heard: "hello", reply: "नमस्ते! चलो खेलते हैं।", lang: "hi", mood: "happy", new_facts: [], parent_alert: false }) }] },
  }],
});
http.createServer((req, res) => {
  req.resume();
  req.on("end", () => setTimeout(() => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(out);
  }, delay));
}).listen(port, "127.0.0.1");
