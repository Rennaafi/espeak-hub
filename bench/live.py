# Live check: real turns spoken through the phone app, logged from the speaker's serial port.
# One row per reply in data/live.csv: cloud stage times (from the audio header, set by the Worker) + the device's BENCH line.
#
#   python live.py --env bench-v0 --block 1 --turns 10     # flashes, then you talk; Ctrl+C stops early
import argparse, csv, datetime, json, pathlib, re, subprocess, time
import serial

ROOT = pathlib.Path(__file__).resolve().parent
COLS = "variant,run,bytes,prebuf_ms,dl_ms,ttfs_ms,play_ms,starves,max_gap_ms,dry,load0,load1,pload0,pload1,frames,max_frame_ms," \
       "hwm_audio,hwm_face,hwm_loop,hwm_i2s,heap_free,heap_min,psram_free,rssi".split(",")

ap = argparse.ArgumentParser()
ap.add_argument("--env", required=True)
ap.add_argument("--block", type=int, required=True, help="block number in the ABBA order (1-4)")
ap.add_argument("--turns", type=int, default=10)
ap.add_argument("--port", default="COM17")
ap.add_argument("--no-flash", action="store_true")
a = ap.parse_args()

if not a.no_flash:
    pio = pathlib.Path.home() / ".platformio/penv/Scripts/pio.exe"
    subprocess.run([str(pio), "run", "-e", a.env, "-t", "upload", "--upload-port", a.port], cwd=ROOT.parent / "firmware", check=True)

stamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
log = open(ROOT / f"data/logs/{stamp}_live_{a.env}.log", "w", encoding="utf-8")
path = ROOT / "data/live.csv"
new = not path.exists()
out = open(path, "a", newline="")
w = csv.writer(out)
if new: w.writerow(["session", "env", "block", "turn", "wall", "stt_ms", "llm_ms", "tts_ms"] + COLS)

ser = serial.Serial()
ser.port, ser.baudrate, ser.timeout = a.port, 115200, 0.2
ser.dtr = ser.rts = False
ser.open()

print(f"{a.env} block {a.block}: wait for 'ready', then talk to Dess through the app ({a.turns} turns)")
turn, head, buf = 0, None, b""
try:
    while turn < a.turns:
        buf += ser.read(4096)
        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1)
            line = line.decode("utf-8", "replace").strip()
            log.write(f"{time.time():.3f} {line}\n"); log.flush()
            if "ws: connected" in line: print("ready")
            if "ws: disconnected" in line: print("  (disconnected: this turn is lost, say it again once 'ready' shows)"); head = None
            if line.startswith("ws: {") and '"type":"audio"' in line:
                head = json.loads(line[4:])
            elif line.startswith("BENCH,") and head:
                row = line.split(",")[1:]
                if len(row) != len(COLS) or float(row[COLS.index("dl_ms")]) < 0: head = None; continue  # aborted reply
                turn += 1
                w.writerow([stamp, a.env, a.block, turn, f"{time.time():.3f}", head.get("stt"), head.get("llm"), head.get("tts")] + row); out.flush()
                d = dict(zip(COLS, row))
                print(f"[{turn}/{a.turns}] cloud {head.get('stt', 0) + head.get('llm', 0) + head.get('tts', 0)} ms + device "
                      f"{float(d['ttfs_ms']):.0f} ms to first sound ({int(d['bytes']) / 48000:.1f} s reply, starves {d['starves']})")
                head = None
except KeyboardInterrupt:
    pass
print(f"{turn} turns -> {path}")
