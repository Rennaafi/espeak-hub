# Makes the three fixed bench clips (Dess's Orpheus "hannah" voice, 24 kHz 16-bit mono) once.
# Uses GROQ_API_KEY from backend/hello-worker/.dev.vars. Re-run only if you want new clips.
import json, pathlib, urllib.request, wave

KEY = next(l.split("=", 1)[1].strip() for l in open("../backend/hello-worker/.dev.vars") if l.startswith("GROQ_API_KEY"))
TEXT = {
    "short": "Sure, done!",
    "medium": "It's twenty past four in the afternoon, and the weather looks clear.",
    "long": "Good question! The ESP32 has two cores, so one can handle Wi-Fi while the other plays my voice. "
            "That way I can keep talking smoothly, even while new data is still arriving from the cloud.",
}

def wav_pcm(b):  # Orpheus WAVs carry a LIST chunk and a 0xffffffff data size, so walk the chunks
    o, rate = 12, 0
    while o + 8 <= len(b):
        cid, size = b[o:o + 4], int.from_bytes(b[o + 4:o + 8], "little")
        if cid == b"fmt ": rate = int.from_bytes(b[o + 12:o + 16], "little")
        if cid == b"data": return rate, b[o + 8:min(len(b), o + 8 + size)]
        o += 8 + size + (size & 1)

for name, text in TEXT.items():
    req = urllib.request.Request("https://api.groq.com/openai/v1/audio/speech", method="POST",
        headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json", "User-Agent": "bench"},
        data=json.dumps({"model": "canopylabs/orpheus-v1-english", "voice": "hannah", "input": text, "response_format": "wav"}).encode())
    rate, pcm = wav_pcm(urllib.request.urlopen(req).read())
    pcm = pcm[:len(pcm) & ~1]
    with wave.open(f"clips/{name}.wav", "wb") as w:  # rewritten as a plain WAV with correct sizes
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate); w.writeframes(pcm)
    print(f"{name}: {rate} Hz, {len(pcm)} bytes, {len(pcm) / 2 / rate:.2f} s")
