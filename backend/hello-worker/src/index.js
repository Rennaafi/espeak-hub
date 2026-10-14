import { DurableObject } from "cloudflare:workers";
import { cannedReply } from "./canned.js";
import { SPEAKER_RATE, joinWavs, resample, splitScript, wavPcm } from "./speech.js";

const GROQ = "https://api.groq.com/openai/v1";
const GEM = "https://generativelanguage.googleapis.com/v1beta";
// Gemini model ids (free tier); swap here if one gets slow or rate-limited
const GEM_LLM = "gemini-3.5-flash-lite"; // also does STT: audio in, text out
const GEM_TTS = "gemini-3.8-flash-tts";
const GEM_VOICE = "Leda";

// Holds the one ESP32 WebSocket (hibernation API: idle sockets don't bill/wake the DO).
// ponytail: single speaker, one fixed instance; per-device ids if there is ever a second speaker
export class Speaker extends DurableObject {
	constructor(ctx, env) {
		super(ctx, env);
		// the runtime answers "ping" with "pong" without waking the DO: free keepalive for the ESP32
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
	}
	async fetch(req) {
		if (req.headers.get("Upgrade") === "websocket") {
			// a reconnecting ESP32 replaces its stale socket (Wi-Fi drops are not noticed for a while)
			for (const old of this.ctx.getWebSockets()) try { old.close(1000, "replaced"); } catch {}
			const [client, server] = Object.values(new WebSocketPair());
			this.ctx.acceptWebSocket(server);
			return new Response(null, { status: 101, webSocket: client });
		}
		// a client that vanished can linger half-closed in getWebSockets(); send() on it throws
		const socks = this.ctx.getWebSockets().filter((ws) => ws.readyState === WebSocket.READY_STATE_OPEN);
		// GET = the app asking "is the speaker connected?" (ponytail: a Wi-Fi-dropped ESP32 still counts until its socket times out)
		if (req.method === "GET") return Response.json({ online: socks.length });
		if (req.headers.get("Content-Type") === "audio/wav") {
			// header message, then raw PCM in frames under the ESP32 client's 15 KB frame limit
			let { rate, pcm } = wavPcm(new Uint8Array(await req.arrayBuffer()));
			if (rate !== SPEAKER_RATE) { pcm = resample(pcm, rate, SPEAKER_RATE); rate = SPEAKER_RATE; }
			// X-Bench (from POST /bench): extra JSON fields for the firmware's benchmark build, e.g. {"run":7,"prebuf":100}
			const bench = JSON.parse(req.headers.get("X-Bench") ?? "{}");
			const head = JSON.stringify({ type: "audio", rate, bytes: pcm.length, mood: req.headers.get("X-Mood") ?? "happy", ...bench });
			for (const ws of socks) {
				ws.send(head);
				for (let o = 0; o < pcm.length; o += CHUNK) ws.send(pcm.subarray(o, o + CHUNK));
			}
		} else {
			const msg = await req.text();
			for (const ws of socks) ws.send(msg);
		}
		return Response.json({ delivered: socks.length });
	}
	// finish the close handshake so the socket leaves getWebSockets()
	webSocketClose(ws, code) {
		try { ws.close(code === 1005 ? 1000 : code); } catch {}
	}
	webSocketError(ws) {
		try { ws.close(1011, "error"); } catch {}
	}
}

const CHUNK = 8192;

const STATES = ["listening", "thinking", "speaking", "idle"];

async function groq(env, path, init) {
	const r = await fetch(GROQ + path, {
		method: "POST",
		...init,
		headers: { Authorization: `Bearer ${env.GROQ_API_KEY}`, ...init.headers },
	});
	if (!r.ok) throw new Error(`groq ${path} ${r.status}: ${await r.text()}`);
	return r;
}

const groqStt = async (env, audio, lang) => {
	const form = new FormData();
	form.append("file", audio); // keep the upload's filename: Whisper sniffs format from the extension
	form.append("model", "whisper-large-v3-turbo");
	form.append("language", lang === "ko" ? "ko" : "en"); // auto-detect misheard short English clips as Icelandic etc.; buddy mode is spoken in English
	form.append("prompt", "Dess"); // spelling hint so the assistant's name isn't heard as Tess/Des
	return (await (await groq(env, "/audio/transcriptions", { body: form })).json()).text.trim();
};

const TZ = "Asia/Jakarta"; // device owner's timezone
const now = () => new Date().toLocaleString("en-US", { timeZone: TZ, dateStyle: "full", timeStyle: "short" });
const BASE = `You are Dess, a curious, slightly cheeky voice assistant. People may call you Tess or Des; that is you. You have no tools; never call any. Answer in at most 2 short spoken sentences (under 40 words), plain text, no markdown. Also pick the mood that fits your reply. `;
const MODE = {
	en: "",
	buddy: " You are also a Korean language buddy: reply in English, and weave in one useful Korean word or phrase written in Hangul followed by its English meaning, like: 'Thank you' is 감사합니다. Never write romanization.",
	ko: " Reply ONLY in natural, polite spoken Korean (해요체) written in Hangul, at most 2 short sentences, no English words.",
};
const persona = (lang) => `${BASE}${MODE[lang]} Current local time: ${now()}.`;

// history comes from the app: untrusted, so keep only well-formed turns, last 6, capped length
const history = (h) =>
	(Array.isArray(h) ? h : [])
		.filter((m) => (m?.role === "user" || m?.role === "assistant") && typeof m.content === "string")
		.slice(-12)
		.map((m) => ({ role: m.role, content: m.content.slice(0, 500) }));

const MOODS = ["neutral", "happy", "tired", "angry", "confused", "laugh"];

// strict json_schema: the model can only answer {mood: one of MOODS, text}, so no tag can leak into TTS
const SCHEMA = {
	type: "json_schema",
	json_schema: {
		name: "reply",
		strict: true,
		schema: {
			type: "object",
			properties: { mood: { type: "string", enum: MOODS }, text: { type: "string" } },
			required: ["mood", "text"],
			additionalProperties: false,
		},
	},
};

// a turn must never fail over the mood: if the JSON is bad, speak the raw text as happy
const parseReply = (raw) => {
	try {
		const { mood, text } = JSON.parse(raw);
		if (typeof text === "string" && text.trim()) return { mood: MOODS.includes(mood) ? mood : "happy", text: text.trim() };
	} catch {}
	return { mood: "happy", text: raw };
};

const groqLlm = async (env, text, past = [], lang = "en") => {
	const ask = () =>
		groq(env, "/chat/completions", {
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: "openai/gpt-oss-20b",
				reasoning_effort: "low",
				response_format: SCHEMA,
				messages: [
					{ role: "system", content: persona(lang) },
					...past,
					{ role: "user", content: text },
				],
			}),
		});
	// gpt-oss now and then tries a tool call anyway and Groq answers 400 "Tool choice is none, but model called a tool".
	// It is random per request, so one retry clears it.
	// ponytail: a single blind retry (any error); narrow it to that 400 if other failures start doubling latency
	const r = await ask().catch(() => ask());
	return parseReply((await r.json()).choices[0].message.content.trim());
};

// curly quotes / non-breaking hyphens trip TTS and the OLED font; markdown marks (**bold**, # head, `code`) get read aloud
const clean = (s) => s.replace(/[*#`]/g, "").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[‐-―]/g, "-").replace(/[  ]/g, " ");

// ponytail: hard cap by sentence; tune MAX if Orpheus input limit or latency bites
const MAX = 300;
const trim = (s) => (s.length <= MAX ? s : s.slice(0, MAX).replace(/[^.!?]*$/, "") || s.slice(0, MAX));

const groqTts = async (env, text) =>
	(await groq(env, "/audio/speech", {
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ model: "canopylabs/orpheus-v1-english", voice: "hannah", input: text, response_format: "wav" }),
	})).arrayBuffer();

// ---- Gemini provider: same three stages, same return shapes as the Groq ones ----
async function gemini(env, model, body) {
	const r = await fetch(`${GEM}/models/${model}:generateContent`, {
		method: "POST",
		headers: { "x-goog-api-key": env.GEMINI_API_KEY, "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!r.ok) throw new Error(`gemini ${model} ${r.status}: ${await r.text()}`);
	return r.json();
}
const gemText = (j) => j.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("").trim() ?? "";

const b64 = (u8) => {
	let s = "";
	for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
	return btoa(s);
};
// Gemini wants a real audio/* type; Flutter's multipart part may be octet-stream, so go by extension
const AUDIO_TYPES = { mp3: "audio/mp3", wav: "audio/wav", m4a: "audio/mp4", mp4: "audio/mp4", aac: "audio/aac", ogg: "audio/ogg", flac: "audio/flac" };
const audioType = (f) => AUDIO_TYPES[f.name?.split(".").pop().toLowerCase()] ?? (f.type.startsWith("audio/") ? f.type : "audio/mp4");

const gemStt = async (env, audio, lang) =>
	gemText(await gemini(env, GEM_LLM, {
		contents: [{ parts: [
			{ text: `Transcribe this audio in ${lang === "ko" ? "Korean (Hangul)" : "English"}. The speaker may say the name "Dess". Reply with only the transcript.` },
			{ inlineData: { mimeType: audioType(audio), data: b64(new Uint8Array(await audio.arrayBuffer())) } },
		] }],
	}));

// ponytail: default thinking level; set generationConfig.thinkingConfig if Flash-Lite latency shows it is reasoning
const gemLlm = async (env, text, past = [], lang = "en") => {
	const j = await gemini(env, GEM_LLM, {
		systemInstruction: { parts: [{ text: persona(lang) }] },
		contents: [...past, { role: "user", content: text }].map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
		generationConfig: {
			responseMimeType: "application/json",
			responseSchema: {
				type: "OBJECT",
				properties: { mood: { type: "STRING", enum: MOODS }, text: { type: "STRING" } },
				required: ["mood", "text"],
			},
		},
	});
	return parseReply(gemText(j));
};

const gemTts = async (env, text) => {
	const j = await gemini(env, GEM_TTS, {
		contents: [{ parts: [{ text }] }],
		generationConfig: {
			responseModalities: ["AUDIO"],
			speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: GEM_VOICE } } },
		},
	});
	const part = j.candidates?.[0]?.content?.parts?.[0]?.inlineData;
	if (!part) throw new Error(`gemini tts returned no audio: ${JSON.stringify(j).slice(0, 200)}`);
	// the 3.8 TTS models answer audio/wav; older ones sent raw L16, which wavPcm() would reject, so fail loudly
	if (!/wav/.test(part.mimeType)) throw new Error(`gemini tts unexpected mime ${part.mimeType}`);
	return Uint8Array.from(atob(part.data), (c) => c.charCodeAt(0)).buffer;
};

// Korean voice: Workers AI MeloTTS (free daily allowance, no key, no region block). 44.1 kHz WAV; the speaker path resamples.
// Supported codes per the API: en es fr jp kr zh ("ko" is rejected)
const meloTts = async (env, text) => {
	const out = await env.AI.run("@cf/myshell-ai/melotts", { prompt: text, lang: "kr" });
	return (typeof out?.audio === "string" ? Uint8Array.from(atob(out.audio), (c) => c.charCodeAt(0)) : new Uint8Array(await new Response(out).arrayBuffer())).buffer;
};

const LANGS = Object.keys(MODE);

// What Dess says, per mode. Buddy replies are English with Korean phrases: MeloTTS reads English with a Korean accent,
// so the English goes to the provider's voice and only the Hangul to MeloTTS, then both are joined into one WAV.
const speak = async (env, P, text, lang) => {
	if (lang === "en") return P.tts(env, text);
	if (lang === "ko") return meloTts(env, text);
	const segs = splitScript(text);
	if (segs.length === 0) return P.tts(env, text);
	if (segs.length === 1) return segs[0].ko ? meloTts(env, text) : P.tts(env, text);
	return joinWavs(await Promise.all(segs.map((s) => (s.ko ? meloTts(env, s.text) : P.tts(env, s.text)))));
};

const PROVIDERS = {
	groq: { stt: groqStt, llm: groqLlm, tts: groqTts },
	gemini: { stt: gemStt, llm: gemLlm, tts: gemTts },
};

export default {
	async fetch(req, env) {
		const url = new URL(req.url);
		if (url.pathname === "/ws" || url.pathname === "/state" || url.pathname === "/status" || url.pathname === "/bench") {
			if (!env.APP_KEY || req.headers.get("X-App-Key") !== env.APP_KEY) return new Response("unauthorized", { status: 401 });
			const speaker = env.SPEAKER.getByName("speaker");
			if (url.pathname === "/status") return speaker.fetch("https://do/status");
			if (url.pathname === "/ws") {
				if (req.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
				return speaker.fetch(req);
			}
			// POST /bench: a fixed WAV (body) + X-Bench JSON goes straight to the speaker, no STT/LLM/TTS (RTOS benchmark, bench/run.py)
			if (url.pathname === "/bench") {
				const bench = req.headers.get("X-Bench") ?? "{}";
				try { JSON.parse(bench); } catch { return new Response("X-Bench must be JSON", { status: 400 }); }
				return speaker.fetch("https://do/push", { method: "POST", body: req.body, headers: { "Content-Type": "audio/wav", "X-Mood": "happy", "X-Bench": bench } });
			}
			// POST /state {"state": "listening"|...} -> pushed to the speaker's face
			if (req.method !== "POST") return new Response("POST {state}", { status: 405 });
			const { state, mood } = await req.json().catch(() => ({}));
			if (!STATES.includes(state)) return new Response(`state must be one of ${STATES}`, { status: 400 });
			if (mood !== undefined && !MOODS.includes(mood)) return new Response(`mood must be one of ${MOODS}`, { status: 400 });
			return speaker.fetch("https://do/push", { method: "POST", body: JSON.stringify({ type: "state", state, mood }) });
		}
		if (req.method !== "POST") return new Response("POST multipart audio(+meta) to /chat (or /stt)", { status: 405 });
		if (!env.APP_KEY || req.headers.get("X-App-Key") !== env.APP_KEY) return new Response("unauthorized", { status: 401 });
		const path = new URL(req.url).pathname;
		let audio, meta;
		try {
			const form = await req.formData();
			audio = form.get("audio");
			meta = JSON.parse(form.get("meta") || "{}");
			if (!(audio instanceof File)) throw 0;
		} catch {
			return new Response("expected multipart: audio=<file>, meta=<json>", { status: 400 });
		}
		const P = PROVIDERS[meta.provider ?? "groq"];
		if (!P) return new Response(`provider must be one of ${Object.keys(PROVIDERS)}`, { status: 400 });
		const lang = meta.lang ?? "en";
		if (!LANGS.includes(lang)) return new Response(`lang must be one of ${LANGS}`, { status: 400 });
		const speaker = meta.target === "speaker" && path === "/chat" ? env.SPEAKER.getByName("speaker") : null;
		const push = (init) => speaker.fetch("https://do/push", { method: "POST", ...init }).then((r) => r.json());
		try {
			const t = { t0: Date.now() };
			if (speaker) await push({ body: JSON.stringify({ type: "state", state: "thinking" }) });
			const heard = await P.stt(env, audio, lang);
			t.stt = Date.now() - t.t0;
			if (path === "/stt") return Response.json({ text: heard, ms: t.stt });

			// /chat: audio in -> WAV reply out, per-stage ms in headers
			// "who are you" / "what can you do" get a fixed answer and skip the LLM stage (llm ms ~0)
			const { mood, text } = cannedReply(heard, lang) ?? (await P.llm(env, heard, history(meta.history), lang));
			const reply = trim(clean(text));
			t.llm = Date.now() - t.t0 - t.stt;
			const wav = await speak(env, P, reply, lang);
			t.tts = Date.now() - t.t0 - t.stt - t.llm;
			if (speaker) {
				// speaker target: the phone gets the transcript + timings as JSON, the WAV goes to the ESP32
				// X-Bench: the cloud stage times ride along in the audio header so bench/live.py can log them next to the device's own timing
				const ms = JSON.stringify({ stt: t.stt, llm: t.llm, tts: t.tts });
				const { delivered } = await push({ body: wav, headers: { "Content-Type": "audio/wav", "X-Mood": mood, "X-Bench": ms } });
				return Response.json({ heard, reply, mood, delivered, ms: { stt: t.stt, llm: t.llm, tts: t.tts, total: Date.now() - t.t0 } });
			}
			return new Response(wav, {
				headers: {
					"Content-Type": "audio/wav",
					"X-Heard": encodeURIComponent(heard),
					"X-Reply": encodeURIComponent(reply),
					"X-Mood": mood,
					"X-Ms-Stt": t.stt, "X-Ms-Llm": t.llm, "X-Ms-Tts": t.tts, "X-Ms-Total": Date.now() - t.t0,
				},
			});
		} catch (e) {
			if (speaker) await push({ body: JSON.stringify({ type: "state", state: "idle" }) }).catch(() => {}); // don't leave the face stuck on "thinking"
			return Response.json({ error: String(e) }, { status: 502 });
		}
	},
};
