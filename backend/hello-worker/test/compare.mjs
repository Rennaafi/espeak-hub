// Groq vs Gemini, English only. Same clip to both each round, order swapped every round.
// Run: node test/compare.mjs [turnsPerProvider=20] [gapSeconds=12]
// Clips: test/clips/1.m4a..10.m4a, truth: test/clips/sentences.json. Worker URL/key: ../../app/env.json
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const N = Number(process.argv[2] ?? 20), GAP = Number(process.argv[3] ?? 12) * 1000;
const { WORKER_URL, APP_KEY } = JSON.parse(readFileSync("../../app/env.json", "utf8"));
const truth = JSON.parse(readFileSync("test/clips/sentences.json", "utf8"));
const OUT = `../../data/compare_${new Date().toISOString().slice(0, 10)}.csv`;
mkdirSync("../../data", { recursive: true });

const NUM = { twelve: "12", fifteen: "15" }; // Whisper/Gemini may write digits; don't score that as an error
const words = (s) => s.toLowerCase().replace(/[^a-z0-9' ]/g, " ").split(/\s+/).filter(Boolean).map((w) => NUM[w] ?? w);
function wer(ref, hyp) {
	const a = words(ref), b = words(hyp);
	const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
	for (let j = 1; j <= b.length; j++) d[0][j] = j;
	for (let i = 1; i <= a.length; i++)
		for (let j = 1; j <= b.length; j++)
			d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
	return d[a.length][b.length] / a.length;
}
const csv = (v) => `"${String(v).replace(/"/g, '""')}"`;
const med = (x) => (x.length ? [...x].sort((p, q) => p - q)[Math.floor((x.length - 1) / 2)] : NaN);
const p95 = (x) => (x.length ? [...x].sort((p, q) => p - q)[Math.min(x.length - 1, Math.ceil(x.length * 0.95) - 1)] : NaN);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function turn(provider, n) {
	const form = new FormData();
	form.append("audio", new Blob([readFileSync(`test/clips/${n}.m4a`)]), `${n}.m4a`);
	form.append("meta", JSON.stringify({ provider, history: [] }));
	const t0 = Date.now();
	const row = { provider, clip: n, ok: 0, heard: "", wer: "", stt: "", llm: "", tts: "", total: "", wall: 0, mood: "", error: "" };
	try {
		const r = await fetch(`${WORKER_URL}/chat`, { method: "POST", headers: { "X-App-Key": APP_KEY }, body: form });
		row.wall = Date.now() - t0;
		if (!r.ok) { row.error = `${r.status} ${(await r.text()).slice(0, 160)}`; return row; }
		await r.arrayBuffer();
		const h = (k) => r.headers.get(k);
		Object.assign(row, { ok: 1, heard: decodeURIComponent(h("X-Heard")), mood: h("X-Mood"), stt: +h("X-Ms-Stt"), llm: +h("X-Ms-Llm"), tts: +h("X-Ms-Tts"), total: +h("X-Ms-Total") });
		row.wer = wer(truth[String(n).padStart(2, "0")], row.heard).toFixed(3);
	} catch (e) { row.wall = Date.now() - t0; row.error = String(e).slice(0, 160); }
	return row;
}

const COLS = ["provider", "clip", "ok", "heard", "wer", "stt", "llm", "tts", "total", "wall", "mood", "error"];
writeFileSync(OUT, "﻿" + COLS.join(",") + "\n"); // BOM so Excel reads UTF-8
const rows = [];
for (let i = 0; i < N; i++) {
	const clip = (i % 10) + 1;
	for (const p of i % 2 ? ["gemini", "groq"] : ["groq", "gemini"]) {
		const row = await turn(p, clip);
		rows.push(row);
		appendFileSync(OUT, COLS.map((c) => csv(row[c])).join(",") + "\n");
		console.log(`${String(i + 1).padStart(2)}/${N} ${p.padEnd(6)} clip ${String(clip).padStart(2)} ${row.ok ? `total ${row.total} ms  wer ${row.wer}` : "FAIL " + row.error}`);
		await sleep(GAP);
	}
}

console.log(`\nsaved ${OUT}\n`);
for (const p of ["groq", "gemini"]) {
	const r = rows.filter((x) => x.provider === p), ok = r.filter((x) => x.ok);
	const col = (k) => ok.map((x) => x[k]);
	console.log(`${p}: ${ok.length}/${r.length} ok, ${r.filter((x) => /429/.test(x.error)).length} x 429`);
	for (const k of ["stt", "llm", "tts", "total"]) console.log(`  ${k.padEnd(5)} median ${med(col(k))}  p95 ${p95(col(k))} ms`);
	console.log(`  median WER ${med(col("wer").map(Number)).toFixed(3)}  perfect transcripts ${ok.filter((x) => +x.wer === 0).length}/${ok.length}`);
}
