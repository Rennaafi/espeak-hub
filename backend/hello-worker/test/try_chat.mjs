// One /chat turn against the deployed Worker, per-stage timings printed, reply saved as WAV.
// Run: node test/try_chat.mjs <groq|gemini> <clip> [outfile.wav] [en|buddy|ko]   (URL + key from ../../app/env.json)
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

const [provider = "groq", clip = "../test.mp3", out = `test/${provider}_reply.wav`, lang = "en"] = process.argv.slice(2);
const { WORKER_URL, APP_KEY } = JSON.parse(readFileSync("../../app/env.json", "utf8"));

const form = new FormData();
form.append("audio", new Blob([readFileSync(clip)]), basename(clip));
form.append("meta", JSON.stringify({ provider, lang, history: [] }));

const t0 = Date.now();
const r = await fetch(`${WORKER_URL}/chat`, { method: "POST", headers: { "X-App-Key": APP_KEY }, body: form });
if (!r.ok) { console.log(r.status, await r.text()); process.exit(1); }
const h = (k) => r.headers.get(k);
writeFileSync(out, Buffer.from(await r.arrayBuffer()));
console.log(`${provider}  heard: ${decodeURIComponent(h("X-Heard"))}`);
console.log(`reply [${h("X-Mood")}]: ${decodeURIComponent(h("X-Reply"))}`);
console.log(`ms  stt ${h("X-Ms-Stt")}  llm ${h("X-Ms-Llm")}  tts ${h("X-Ms-Tts")}  total ${h("X-Ms-Total")}  (wall ${Date.now() - t0})  -> ${out}`);
