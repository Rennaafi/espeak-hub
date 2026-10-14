# Drives one benchmark session: pushes the fixed clips to the speaker through POST /bench in a shuffled
# order and appends the firmware's "BENCH," lines to data/bench.csv (raw serial log in data/logs/).
#
#   python run.py --env bench-v1 --prebuf 0 50 100 250 500 --reps 20
#
# --env flashes that PlatformIO env first (skip with --no-flash). Host + key come from firmware/src/secrets.h.
import argparse, csv, datetime, json, pathlib, random, re, subprocess, sys, time, urllib.request
import serial

ROOT = pathlib.Path(__file__).resolve().parent
FW = ROOT.parent / "firmware"
SECRETS = dict(re.findall(r'#define\s+(\w+)\s+"([^"]*)"', (FW / "src/secrets.h").read_text()))
HOST, KEY = SECRETS["WORKER_HOST"], SECRETS["APP_KEY"]
COLS = "variant,run,bytes,prebuf_ms,dl_ms,ttfs_ms,play_ms,starves,max_gap_ms,dry,load0,load1,pload0,pload1,frames,max_frame_ms," \
       "hwm_audio,hwm_face,hwm_loop,hwm_i2s,heap_free,heap_min,psram_free,rssi".split(",")
HOLD_S = 4  # firmware holds the mood face 3 s after a reply and only takes the next one after that

ap = argparse.ArgumentParser()
ap.add_argument("--env", required=True, help="PlatformIO env, e.g. bench-v0")
ap.add_argument("--prebuf", type=int, nargs="+", default=[0], help="prebuffer values to sweep (ms)")
ap.add_argument("--clips", nargs="+", default=["short", "medium", "long"])
ap.add_argument("--reps", type=int, default=20)
ap.add_argument("--port", default="COM17")
ap.add_argument("--seed", type=int, default=None)
ap.add_argument("--no-flash", action="store_true")
ap.add_argument("--start", type=int, default=0, help="resume an interrupted session at this run index (same --seed)")
a = ap.parse_args()

if not a.no_flash:
    pio = pathlib.Path.home() / ".platformio/penv/Scripts/pio.exe"
    subprocess.run([str(pio), "run", "-e", a.env, "-t", "upload", "--upload-port", a.port], cwd=FW, check=True)

seed = a.seed if a.seed is not None else int(time.time())
sched = [(c, p) for c in a.clips for p in a.prebuf] * a.reps
random.Random(seed).shuffle(sched)
wavs = {c: (ROOT / f"clips/{c}.wav").read_bytes() for c in a.clips}

stamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
(ROOT / "data/logs").mkdir(parents=True, exist_ok=True)
log = open(ROOT / f"data/logs/{stamp}_{a.env}.log", "w", encoding="utf-8")
out_path = ROOT / "data/bench.csv"
new = not out_path.exists()
out = open(out_path, "a", newline="")
w = csv.writer(out)
if new: w.writerow(["session", "env", "seed", "clip", "wall"] + COLS)

ser = serial.Serial()
ser.port, ser.baudrate, ser.timeout = a.port, 115200, 0.2
ser.dtr = ser.rts = False  # don't pulse EN/IO0 on open
ser.open()

def lines(until):  # yields serial lines until the deadline, mirrored to the log
    buf = b""
    while time.time() < until:
        buf += ser.read(4096)
        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1)
            line = line.decode("utf-8", "replace").strip()
            log.write(f"{time.time():.3f} {line}\n")
            yield line

def post(path, body=None, headers={}):
    req = urllib.request.Request(f"https://{HOST}{path}", data=body, method="POST" if body is not None else "GET",
                                 headers={"X-App-Key": KEY, "User-Agent": "bench", **headers})
    for attempt in range(5):  # the laptop's own uplink drops now and then (WinError 10054)
        try: return json.loads(urllib.request.urlopen(req, timeout=30).read())
        except OSError as e:
            print(f"POST {path} failed ({e}), retry {attempt + 1}/5"); time.sleep(5 * (attempt + 1))
    sys.exit(f"POST {path} kept failing")

def wait_online(timeout=120):
    # wait for the firmware's own "ws: connected": /status alone can still count a just-reset board's dead socket
    for line in lines(time.time() + timeout):
        if "ws: connected" in line: return
    sys.exit("speaker never said 'ws: connected' (reset it with EN, or check Wi-Fi)")

print(f"{a.env}: {len(sched)} runs, seed {seed}, waiting for the speaker...")
if a.no_flash and post("/status")["online"]: print("already online")
else: wait_online()
for _ in lines(time.time() + 3): pass  # let boot chatter / face settle

i = a.start
while i < len(sched):
    clip, p = sched[i]
    r = post("/bench", wavs[clip], {"Content-Type": "audio/wav", "X-Bench": json.dumps({"run": i, "prebuf": p})})
    if not r.get("delivered"):
        print(f"run {i}: speaker offline, waiting"); wait_online(); continue
    row, dropped = None, False
    for line in lines(time.time() + 60):
        if line.startswith("BENCH,") and line.split(",")[2] == str(i):
            if dropped: continue  # V1+ still reports the aborted reply (dl_ms < 0): not a valid run
            row = line.split(",")[1:]; break
        if "ws: disconnected" in line:  # the reply is lost; retry the same run once the socket is back
            dropped = True
            print(f"run {i}: DISCONNECTED mid-reply ({clip}, P={p}) at {time.time():.3f}")
        if dropped and "ws: connected" in line: break
    if row is None:
        if not dropped: print(f"run {i}: no BENCH line, retrying"); wait_online()
        for _ in lines(time.time() + 3): pass
        continue
    if len(row) != len(COLS): sys.exit(f"BENCH line has {len(row)} fields, expected {len(COLS)}: firmware/run.py out of sync")
    w.writerow([stamp, a.env, seed, clip, f"{time.time():.3f}"] + row); out.flush()
    d = dict(zip(COLS, row))
    print(f"[{i + 1}/{len(sched)}] {clip:6} P={p:<4} ttfs={d['ttfs_ms']:>9} dl={d['dl_ms']:>9} starves={d['starves']} "
          f"dry={d['dry']} load0={d['load0']} pload1={d['pload1']} rssi={d['rssi']}")
    i += 1
    for _ in lines(time.time() + HOLD_S): pass
print("done ->", out_path)
