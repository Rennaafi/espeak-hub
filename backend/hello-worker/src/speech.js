// Pure audio/text helpers (no Workers imports, so test/speech_check.mjs can run them in Node).

export const SPEAKER_RATE = 24000; // the ESP32 clocks I2S at this fixed rate and ignores anything else (firmware AUDIO_RATE)

// Orpheus WAVs have a LIST chunk before "data" and a streamed 0xffffffff size, so walk the chunks
export function wavPcm(b) {
	const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
	let rate = 0;
	for (let o = 12; o + 8 <= b.length; ) {
		const id = String.fromCharCode(...b.subarray(o, o + 4)), size = v.getUint32(o + 4, true);
		if (id === "fmt ") {
			// the ESP32 player assumes 16-bit mono PCM
			if (v.getUint16(o + 8, true) !== 1 || v.getUint16(o + 10, true) !== 1 || v.getUint16(o + 22, true) !== 16) throw new Error("wav must be 16-bit mono PCM");
			rate = v.getUint32(o + 12, true);
		} else if (id === "data" && rate) {
			return { rate, pcm: b.subarray(o + 8, Math.min(b.length, o + 8 + size)) };
		}
		o += 8 + size + (size & 1);
	}
	throw new Error("no fmt/data chunk in wav");
}

// ponytail: linear interpolation, no low-pass first; fine for speech on a 3 W speaker, add a filter if 44.1k -> 24k sounds gritty
export function resample(pcm, from, to) {
	const src = new Int16Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + (pcm.length & ~1)));
	const out = new Int16Array(Math.floor((src.length * to) / from));
	for (let i = 0; i < out.length; i++) {
		const x = (i * from) / to, j = Math.floor(x);
		out[i] = src[j] + (src[Math.min(j + 1, src.length - 1)] - src[j]) * (x - j);
	}
	return new Uint8Array(out.buffer);
}

/**
 * Buddy mode: split a reply into Korean runs (Hangul words plus their trailing punctuation) and the English around them,
 * so each can be spoken by a voice that suits it. English pieces with no letters (stray quotes, dashes) are dropped.
 * ponytail: script-based, so Hangul inside an English sentence is the only trigger; romanized Korean stays English
 */
export function splitScript(text) {
	return text
		.split(/([가-힣]+(?:\s+[가-힣]+)*[.!?~,]*)/)
		.map((t, i) => ({ ko: i % 2 === 1, text: t.trim() }))
		.filter((s) => s.text && (s.ko || /[A-Za-z0-9]/.test(s.text)))
		.reduce((out, s) => (out.at(-1)?.ko === s.ko ? (out.at(-1).text += " " + s.text, out) : [...out, s]), []); // merge neighbours: one call per voice change
}

/** Concatenate WAVs (any rate, 16-bit mono) into one 24 kHz WAV with a short pause between pieces. */
export function joinWavs(wavs, gapMs = 100) {
	const gap = new Uint8Array(((SPEAKER_RATE * gapMs) / 1000) * 2);
	const pcms = wavs.map((w) => {
		const { rate, pcm } = wavPcm(new Uint8Array(w));
		return rate === SPEAKER_RATE ? pcm : resample(pcm, rate, SPEAKER_RATE);
	});
	const parts = pcms.flatMap((p, i) => (i ? [gap, p] : [p]));
	const len = parts.reduce((n, p) => n + p.length, 0);
	const out = new Uint8Array(44 + len);
	const v = new DataView(out.buffer);
	const tag = (o, s) => [...s].forEach((c, i) => (out[o + i] = c.charCodeAt(0)));
	tag(0, "RIFF"); v.setUint32(4, 36 + len, true); tag(8, "WAVEfmt ");
	v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
	v.setUint32(24, SPEAKER_RATE, true); v.setUint32(28, SPEAKER_RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
	tag(36, "data"); v.setUint32(40, len, true);
	let o = 44;
	for (const p of parts) { out.set(p, o); o += p.length; }
	return out.buffer;
}
