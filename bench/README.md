# RTOS benchmark: is the speaker's task flow optimal?

Question: does buffering the whole reply before playing (V0) cost noticeable latency, and can FreeRTOS
streaming (V1) cut it without audio starvation? Secondary: CPU load per core, face smoothness, stack/heap headroom.

## Variants (PlatformIO envs in `../firmware/platformio.ini`, same `speaker.cpp` + `-D` flags)

| env | what changes |
|---|---|
| `bench-v0` | current flow: loop task copies the whole reply into PSRAM, then notifies the audio task |
| `bench-v1` | `StreamBuffer` (1 MB, PSRAM): loop task produces, audio task starts after P ms are buffered |
| `bench-v2` | V1 without busy polling: `loop()` blocks a tick per pass (core 1), face task on a 33 ms `vTaskDelayUntil` period (core 0) |
| `bench-v3` | V2 + WebSocket loop task priority 4 (above audio's 3) |
| `bench-v4` | V2 + 128-frame block writes to I2S instead of one `I2S.write` (mutex + ring send) per sample |

Why V3/V4 build on V2: the stock Arduino loop task never blocks, so core 1's idle task never runs (load reads 100 %,
hiding the audio task's cost), and a never-blocking task above the audio task would starve it outright.

## Stimulus

`POST /bench` on the Worker pushes a fixed WAV (body) through the Durable Object exactly like a real reply,
skipping STT/LLM/TTS; header `X-Bench: {"run":n,"prebuf":P}`. Clips (`clips/`, made once by `make_clips.py`,
Orpheus "hannah" 24 kHz mono): short 2.08 s, medium 4.00 s, long 13.36 s.

## Measurements (firmware, `-D BENCH`, one `BENCH,...` serial line per reply, printed after playback)

- `ttfs_ms` time to first sound: audio header received -> first sample handed to I2S (includes the 30 ms amp wake-up)
- `dl_ms` header -> last byte received; `play_ms` first -> last sample
- `starves` times the audio task found the stream buffer empty mid-reply, `max_gap_ms` the longest such wait
- `dry` times the I2S library's ring buffer was found empty (its DMA task had nothing to refill DMA with)
- `load0/1` core load over the whole reply, `pload0/1` over playback only: idle-hook cycle counting
  (FreeRTOS run-time stats are compiled out of the Arduino core)
- `frames`, `max_frame_ms` face frames drawn and longest gap between them; `hwm_*` stack bytes never used;
  heap/PSRAM free; Wi-Fi RSSI

## Run

```
python make_clips.py                                               # once
python run.py --env bench-v0 --reps 20                             # 3 clips x 20, shuffled
python run.py --env bench-v1 --prebuf 0 50 100 250 500 --reps 20   # 300 runs
python run.py --env bench-v2 --prebuf <P*> --reps 20               # same for v3, v4
python analyze.py                                                  # results/ + figures/
```

P* = smallest P with zero starvation over all V1 runs. The rule fixed before the sweep also required zero dry events;
no P met it (dry events turned out P-independent), so it was amended after the sweep and the report says so.
Raw serial logs: `data/logs/`. Everything appends to `data/bench.csv`.

## Known limits

- Software timestamps only (no scope): "first sound" is when the sample enters the I2S driver; the ~21 ms of
  library ring + DMA buffering after that is the same for every variant.
- Starvation is a buffer-level proxy for an audible gap (conservative: ~21 ms of I2S buffering still
  covers short gaps).
- Device and cloud latency come from different clocks, so they are reported side by side, not as one measured sum.
- The idle-hook load method keeps the idle task spinning (no WAITI) in bench builds: fine for timing, not for power.
- Network drift: the phone hotspot dropped mid-study and came back slower (~100 vs ~150 kB/s). V4 only exists after
  the outage, so V2 was re-run there as a same-network control (`--seed 202`); download/starvation comparisons in
  `analyze.py` stay within one network period. CPU load is network-independent.
