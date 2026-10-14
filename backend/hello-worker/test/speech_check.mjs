// Run: node test/speech_check.mjs   (no network)
// Checks the buddy-mode text splitter and the WAV joiner; if the sample WAVs from earlier voice tests exist,
// also writes test/buddy_join.wav = hannah (English) + MeloTTS (Korean) joined, so you can hear the seam.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { SPEAKER_RATE, joinWavs, splitScript, wavPcm } from "../src/speech.js";

// ---- splitter ----
const sp = (t) => splitScript(t).map((s) => `${s.ko ? "KO" : "EN"}:${s.text}`);
assert.deepEqual(sp("'Thank you' is 감사합니다."), ["EN:'Thank you' is", "KO:감사합니다."]);
assert.deepEqual(sp("Hello in Korean is 안녕하세요! Try it."), ["EN:Hello in Korean is", "KO:안녕하세요!", "EN:Try it."]);
assert.deepEqual(sp("Good morning is 좋은 아침이에요, and thanks is 고마워요."), ["EN:Good morning is", "KO:좋은 아침이에요,", "EN:and thanks is", "KO:고마워요."]);
assert.deepEqual(sp("Just English here."), ["EN:Just English here."]);
assert.deepEqual(sp("안녕하세요! 오늘 기분이 어때요?"), ["KO:안녕하세요! 오늘 기분이 어때요?"]); // neighbours of one language merge
assert.deepEqual(sp("It's called 'hi' — 안녕 — right?"), ["EN:It's called 'hi' —", "KO:안녕", "EN:— right?"]);
assert.deepEqual(sp("… 감사합니다 …"), ["KO:감사합니다"]); // stray punctuation-only English is dropped

// ---- joiner ----
const wav = (rate, samples, extra = Buffer.alloc(0)) => {
	// mono 16-bit WAV, optional LIST chunk before data (like Orpheus), streamed 0xffffffff data size when extra is set
	const pcm = Buffer.from(new Int16Array(samples).buffer);
	const h = Buffer.alloc(36);
	h.write("RIFF", 0); h.writeUInt32LE(0xffffffff, 4); h.write("WAVEfmt ", 8);
	h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
	h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
	const d = Buffer.alloc(8); d.write("data", 0); d.writeUInt32LE(extra.length ? 0xffffffff : pcm.length, 4);
	return Buffer.concat([h, extra, d, pcm]);
};
const tone = (rate, sec, hz = 440) => Array.from({ length: Math.round(rate * sec) }, (_, i) => Math.round(8000 * Math.sin((2 * Math.PI * hz * i) / rate)));
const list = Buffer.concat([Buffer.from("LIST"), Buffer.from(new Uint32Array([4]).buffer), Buffer.from("INFO")]);

const a = wav(24000, tone(24000, 0.5), list); // Orpheus-style
const b = wav(44100, tone(44100, 0.5, 880)); // MeloTTS-style
const joined = joinWavs([a.buffer.slice(a.byteOffset, a.byteOffset + a.length), b.buffer.slice(b.byteOffset, b.byteOffset + b.length)]);
const { rate, pcm } = wavPcm(new Uint8Array(joined));
assert.equal(rate, SPEAKER_RATE);
const want = 12000 + 2400 + 12000; // 0.5 s + 100 ms gap + 0.5 s, in samples at 24 kHz
assert.ok(Math.abs(pcm.length / 2 - want) <= 2, `joined samples ${pcm.length / 2} vs ${want}`);
const s = new Int16Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.length));
assert.ok(s.slice(12000, 14400).every((x) => x === 0), "gap is silent");
assert.ok(Math.max(...s.slice(14400)) > 7500, "second piece survived resampling");
assert.equal(joined.byteLength, 44 + pcm.length);
console.log("speech_check ok: splitter + joiner");

// ---- listen: real voices, if the earlier test files are there ----
const en = "test/en_out/groq_hannah.wav", ko = "test/ko_out/melo_ko_kr.wav";
if (existsSync(en) && existsSync(ko)) {
	const buf = (p) => { const x = readFileSync(p); return x.buffer.slice(x.byteOffset, x.byteOffset + x.length); };
	writeFileSync("test/buddy_join.wav", Buffer.from(joinWavs([buf(en), buf(ko)])));
	console.log("wrote test/buddy_join.wav (hannah, then Korean) -> ii test\\buddy_join.wav");
}
