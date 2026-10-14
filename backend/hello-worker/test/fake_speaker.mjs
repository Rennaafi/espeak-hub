// Fake ESP32: node test/fake_speaker.mjs <base-url> <app-key> [clip.mp3]   (e.g. http://localhost:8787 testkey ../test.mp3)
// With a clip it also runs a full /chat target=speaker turn (calls Groq for real).
// Checks /ws auth, ping->pong, /state push reaches the socket, bad input rejected, reconnect replaces old socket.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import WebSocket from "ws";

const [base = "http://localhost:8787", key = "testkey", clip] = process.argv.slice(2);
const wsUrl = base.replace(/^http/, "ws") + "/ws";
const post = (path, body, k = key) =>
	fetch(base + path, { method: "POST", headers: { "X-App-Key": k }, body: JSON.stringify(body) });
const next = (ws) => new Promise((res) => ws.once("message", (d) => res(d.toString())));
const open = (ws) => new Promise((res, rej) => (ws.once("open", res), ws.once("error", rej)));

assert.equal((await fetch(base + "/ws")).status, 401, "no key -> 401");
assert.equal((await fetch(base + "/ws", { headers: { "X-App-Key": key } })).status, 426, "no upgrade -> 426");
assert.equal((await post("/state", { state: "idle" }, "wrong")).status, 401, "wrong key -> 401");
assert.deepEqual(await (await post("/state", { state: "idle" })).json(), { delivered: 0 }, "no speaker online");
assert.equal((await post("/state", { state: "dance" })).status, 400, "bad state -> 400");

const a = new WebSocket(wsUrl, { headers: { "X-App-Key": key } });
await open(a);
a.send("ping");
assert.equal(await next(a), "pong");
const got = next(a);
assert.deepEqual(await (await post("/state", { state: "thinking" })).json(), { delivered: 1 });
assert.deepEqual(JSON.parse(await got), { type: "state", state: "thinking" });

const closed = new Promise((res) => a.once("close", res));
const b = new WebSocket(wsUrl, { headers: { "X-App-Key": key } });
await open(b);
await closed; // old socket was replaced
assert.deepEqual(await (await post("/state", { state: "idle" })).json(), { delivered: 1 });
if (clip) {
	// full speaker turn: spoken clip in -> thinking state, audio header, PCM frames summing to the announced size
	const msgs = [];
	b.on("message", (d, isBin) => msgs.push(isBin ? d.length : JSON.parse(d.toString())));
	const form = new FormData();
	form.append("audio", new Blob([readFileSync(clip)]), basename(clip));
	form.append("meta", JSON.stringify({ target: "speaker" }));
	const r = await fetch(base + "/chat", { method: "POST", headers: { "X-App-Key": key }, body: form });
	const j = await r.json();
	assert.equal(r.status, 200, JSON.stringify(j));
	assert.equal(j.delivered, 1);
	await new Promise((res) => setTimeout(res, 1000));
	assert.deepEqual(msgs[0], { type: "state", state: "thinking" });
	const head = msgs.find((m) => m.type === "audio");
	assert.equal(head.rate, 24000);
	const frames = msgs.filter((m) => typeof m === "number");
	assert.equal(frames.reduce((a, n) => a + n, 0), head.bytes, "frames sum to announced bytes");
	assert.ok(Math.max(...frames) <= 8192, "frames fit the ESP32 limit");
	console.log(`speaker turn ok: "${j.heard}" -> "${j.reply}" [${j.mood}], ${head.bytes} PCM bytes in ${frames.length} frames, ${j.ms.total} ms`);
}
b.close();
await new Promise((res) => setTimeout(res, 500));
// regression: a closed client must not count as a listener or make send() throw
assert.deepEqual(await (await post("/state", { state: "idle" })).json(), { delivered: 0 }, "closed socket not counted");
console.log("fake_speaker: all checks passed");
