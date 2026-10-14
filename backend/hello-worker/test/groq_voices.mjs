// Compare Orpheus female voices. Run: node test/groq_voices.mjs
// Key comes from .dev.vars (GROQ_API_KEY=...), never printed.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const KEY = /^GROQ_API_KEY=(.+)$/m.exec(readFileSync(".dev.vars", "utf8"))?.[1].trim();
if (!KEY) throw new Error("GROQ_API_KEY not found in .dev.vars");

mkdirSync("test/en_out", { recursive: true });
for (const voice of ["autumn", "diana", "hannah"]) {
  const t0 = Date.now();
  const r = await fetch("https://api.groq.com/openai/v1/audio/speech", {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "canopylabs/orpheus-v1-english",
      voice,
      input: "Hi, I'm Dess. Did you know octopuses have three hearts? Pretty cheeky, right?",
      response_format: "wav",
    }),
  });
  if (!r.ok) { console.log(voice, "FAILED", r.status, (await r.text()).slice(0, 300)); continue; }
  writeFileSync(`test/en_out/groq_${voice}.wav`, Buffer.from(await r.arrayBuffer()));
  console.log(voice, `${Date.now() - t0} ms`);
}
