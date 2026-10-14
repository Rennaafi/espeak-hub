// Step 1 check: which Gemini models does the key see, and does TTS speak Korean?
// Run: $env:GEMINI_API_KEY = (Get-Clipboard).Trim(); node test/gemini_check.mjs [ttsModel]
import { mkdirSync, writeFileSync } from "node:fs";

const KEY = process.env.GEMINI_API_KEY;
if (!KEY) throw new Error("set $env:GEMINI_API_KEY first");
const BASE = "https://generativelanguage.googleapis.com/v1beta";
const H = { "x-goog-api-key": KEY, "content-type": "application/json" };

const r = await fetch(`${BASE}/models?pageSize=200`, { headers: H });
if (!r.ok) throw new Error(`list models ${r.status}: ${await r.text()}`);
const models = (await r.json()).models.map((m) => m.name.replace("models/", ""));
console.log("TTS models:", models.filter((n) => /tts/i.test(n)));
console.log("Flash-Lite models:", models.filter((n) => /flash-lite/i.test(n)));

const model = process.argv[2] ?? models.find((n) => /tts/i.test(n));
console.log("\nusing TTS model:", model);

const tests = [
  ["ko_kore", "Kore", "안녕하세요! 저는 데스예요. 오늘 기분이 어때요?"],
  ["ko_puck", "Puck", "안녕하세요! 저는 데스예요. 오늘 기분이 어때요?"],
  ["ko_leda", "Leda", "안녕하세요! 저는 데스예요. 오늘 기분이 어때요?"],
  ["buddy_kore", "Kore", "Thank you in Korean is 감사합니다. Try saying it with me!"],
];

mkdirSync("test/ko_out", { recursive: true });
for (const [name, voice, text] of tests) {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/models/${model}:generateContent`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({
      contents: [{ parts: [{ text }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
      },
    }),
  });
  const ms = Date.now() - t0;
  if (!res.ok) { console.log(name, "FAILED", res.status, (await res.text()).slice(0, 300)); continue; }
  const part = (await res.json()).candidates?.[0]?.content?.parts?.[0]?.inlineData;
  if (!part) { console.log(name, "no audio in reply"); continue; }
  const pcm = Buffer.from(part.data, "base64");
  const rate = Number(/rate=(\d+)/.exec(part.mimeType)?.[1] ?? 24000);
  const hdr = Buffer.alloc(44); // 16-bit mono WAV header
  hdr.write("RIFF", 0); hdr.writeUInt32LE(36 + pcm.length, 4); hdr.write("WAVEfmt ", 8);
  hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(1, 22);
  hdr.writeUInt32LE(rate, 24); hdr.writeUInt32LE(rate * 2, 28); hdr.writeUInt16LE(2, 32);
  hdr.writeUInt16LE(16, 34); hdr.write("data", 36); hdr.writeUInt32LE(pcm.length, 40);
  writeFileSync(`test/ko_out/${model}_${name}.wav`, Buffer.concat([hdr, pcm]));
  console.log(name, `${ms} ms`, part.mimeType, `${(pcm.length / 2 / rate).toFixed(1)} s audio`);
}
