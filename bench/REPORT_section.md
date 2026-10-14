# Performance evaluation of the FreeRTOS task flow

## 1 Question

The speaker receives each spoken reply as 16-bit, 24 kHz PCM over a WebSocket and plays it over I2S while an OLED
face animates. The original firmware (V0) copies the whole reply into PSRAM before the audio task starts playing.
We ask whether this task flow is optimal for the user-visible metric — **time to first sound (TTFS)** — under the
hard constraint of **no audio starvation**, and what it costs in CPU load, face smoothness, stack and heap.

## 2 System under test

ESP32-S3 (2 cores, 240 MHz, 8 MB PSRAM), Arduino core 2.x on ESP-IDF 4.4 / FreeRTOS, 1 kHz tick.

| Task | Core | Priority | Role |
|---|---|---|---|
| `loopTask` (Arduino) | 1 | 1 | `ws.loop()`: WebSocket receive, reply framing |
| `audioTask` | 1 | 3 | PCM → `I2S.write`, amplifier enable |
| `faceTask` | 0 | 1 | eye animation, 128×64 OLED over I2C, target 30 fps |
| `onDmaTransferComplete` (I2S library, hidden) | any | 2 | copies a 1 KB ring buffer into 2 × 128-frame DMA buffers (~21 ms total) |

Static inspection found two properties that shape the study:
(i) the Arduino `loopTask` never blocks, so the idle task of core 1 never runs and core 1 reads 100 % busy whatever
the audio task does; a task like this placed *above* the audio task would starve it completely;
(ii) the I2S library takes a mutex and performs one `xRingbufferSend` **per sample**, i.e. 48 000 kernel calls per second.

## 3 Variants

All variants are the same source file selected by `-D` flags (PlatformIO envs `bench-v0` … `bench-v4`).

| Variant | Change (cumulative) | Hypothesis |
|---|---|---|
| V0 | baseline: buffer whole reply in PSRAM, then notify the audio task | TTFS grows linearly with reply length |
| V1 | `StreamBuffer` (1 MB, PSRAM): loop task produces, audio task starts after P ms are buffered | TTFS becomes independent of length |
| V2 | V1 + `loop()` blocks one tick per pass; face task periodic (`vTaskDelayUntil`, 33 ms) | removes busy polling, frees core 1 |
| V3 | V2 + network task priority 4 (above audio) | faster download, risk to audio |
| V4 | V2 + 256-sample block writes (`I2S.write_blocking`) instead of per-sample `I2S.write` | lower I2S kernel overhead |

## 4 Method

**Stimulus.** A `POST /bench` route on the Cloudflare Worker pushes a fixed WAV through the same Durable Object and
WebSocket path as a real reply, skipping speech recognition, LLM and TTS, so only the device and network are measured.
Three clips (Orpheus TTS, 24 kHz mono): short 2.08 s (100 kB), medium 4.00 s (192 kB), long 13.36 s (641 kB).

**Instrumentation** (`-D BENCH`, compiled out otherwise; no oscilloscope or logic analyser was available, so all
timing is software, `esp_timer` µs resolution):
- TTFS: audio header received → first sample handed to the I2S driver (includes the 30 ms amplifier wake-up);
- download time: header → last byte; starvation: audio task found the stream buffer empty mid-reply;
  dry events: I2S library ring buffer found empty;
- per-core load: FreeRTOS run-time statistics are compiled out of the precompiled Arduino core, so load is measured
  with an idle hook per core that counts CPU cycles spent in the idle task (`cpu_hal_get_cycle_count`);
  `pload` is load during playback only;
- face: frames drawn and the longest gap between frames; stack high-water mark of every task; heap/PSRAM free; RSSI.

**Design.** 20 repetitions per clip per condition, run order shuffled with a fixed seed. V1 swept P ∈ {0, 50, 100,
250, 500} ms (300 runs); V2–V4 ran at the selected P*. Medians with IQR are reported; groups are compared with the
two-sided Mann–Whitney U test and a 10 000-resample bootstrap 95 % CI of the median difference; proportions with
Fisher's exact test. Runs cut off by a Wi-Fi disconnect are excluded from timing statistics and reported separately.

**Selection rule for P\*.** Pre-registered: the smallest P with zero starvation *and* zero dry events over all V1 runs.
**Deviation:** no P met it, because dry events occurred at every P (they do not depend on P, see §5.2); the rule was
amended after the sweep to zero starvation only, giving **P\* = 250 ms**.

## 5 Results

### 5.1 Streaming removes the length-dependent wait (Fig. 1)

| Clip | V0 TTFS | V1 TTFS (P = 250 ms) | Difference [95 % CI] | p (MWU) |
|---|---|---|---|---|
| short (2.1 s) | 669 ms | 143 ms | 527 ms [487, 561] | 6.8 × 10⁻⁸ |
| medium (4.0 s) | 1307 ms | 147 ms | 1160 ms [1117, 1315] | 6.8 × 10⁻⁸ |
| long (13.4 s) | 4403 ms | 142 ms | 4261 ms [4222, 4357] | 6.8 × 10⁻⁸ |

V0's TTFS grows by 7.47 ms per kB of reply (r = 0.945); V1's does not depend on length (−0.01 ms/kB, r = −0.05).
Every one of the 20 V1 runs per clip started faster than the fastest V0 run (U = 400, complete separation).
Placed after the measured cloud stages (STT + LLM + TTS medians), the end-of-speech-to-first-sound time for a
medium reply drops from about 3.0 s to 1.9 s (Fig. 4; device and cloud measured on different clocks, shown side by side).

### 5.2 Prebuffer size (Fig. 2)

The Worker sends 8 192-byte frames (170.7 ms of audio), so every P ≤ 170 ms starts on the first frame (TTFS ≈ 31 ms)
and P = 250 or 500 ms waits for the second (≈ 145 ms).

| P (ms) | runs starved | starvation events | longest gap | dry events | TTFS median |
|---|---|---|---|---|---|
| 0 | 1/59 | 4 | 187 ms | 3 | 30.8 ms |
| 50 | 5/60 | 7 | 536 ms | 3 | 31.1 ms |
| 100 | 3/58 | 5 | 145 ms | 2 | 30.9 ms |
| **250** | **0/60** | 0 | — | 1 | 145.3 ms |
| 500 | 1/59 | 8 | 652 ms | 1 | 145.5 ms |

Pooled, starting on the first frame starved 9/177 runs (5.1 %) against 1/119 (0.8 %) when waiting for the second
(Fisher p = 0.054): a trade of about 115 ms of TTFS for a roughly six-fold drop in starvation risk, suggestive but
not significant at α = 0.05. 0/60 at P = 250 bounds the true per-run starvation rate below about 5 % (rule of three).
The single P = 500 starvation happened in a run whose download (7.4 s for 4 s of audio) was slower than real time;
no finite prebuffer short of the whole reply protects against that.

### 5.3 RTOS overheads (Fig. 3)

Load during playback, median [IQR], all clips pooled, at P\* (V0 has no P):

| Variant | Core 0 | Core 1 | Longest face gap | Stack free (min): audio / face / loop / I2S |
|---|---|---|---|---|
| V0 | 6.9 % | 100.0 % | 61.8 ms | 1788 / 6288 / 3852 / 18444 B |
| V1 | 11.1 % | 92.8 % | 63.0 ms | 1772 / 6256 / 3868 / 18452 B |
| V2 | 9.9 % | 66.2 % | 69.7 ms | 1804 / 6320 / 3884 / 18452 B |
| V3 | 10.4 % | 69.6 % | 70.1 ms | 1772 / 6320 / 3852 / 18452 B |
| V4 | 9.9 % | **14.5 %** | 70.1 ms | 1804 / 6320 / 3900 / 18444 B |

- **Busy polling (V1 → V2).** Blocking the loop task for one tick per pass cut core-1 load from 92.8 % to 66.2 %
  (−26.6 points [26.2, 27.8], p = 7 × 10⁻²⁸) with no measurable change in download time (p = 0.18, same network period).
  V0 reads exactly 100 % because its idle task never runs.
- **Network priority (V2 → V3).** Raising the WebSocket task above the audio task cost 3.4 points of core-1 load
  (p = 3 × 10⁻²⁴) for at most a marginal download gain (−128 ms median, 95 % CI [11, 463] ms, p = 0.055, same network
  period). Its 2/46 starved runs (V2: 0/60, Fisher p = 0.19) both came at the start of a session whose link ran at
  24 kB/s, i.e. slower than real time, so they say nothing against the priority change itself. The bottleneck is
  the radio link, not the CPU, so priority has little to win.
- **Per-sample I2S writes (V2 → V4).** Writing 256-sample blocks cut core-1 playback load from 66.2 % to 14.5 %
  (−51.7 points [51.5, 51.8], p = 7 × 10⁻²⁸): about 78 % of the remaining core-1 work was kernel overhead from
  one mutex + ring-buffer send per sample. V4 could only be run after the hotspot outage, on a slower link
  (≈ 100 kB/s instead of ≈ 150 kB/s), so V2 was re-run as a control in the same period: core-1 load 66.2 vs 14.5 %
  (p = 3 × 10⁻²¹), download time 1743 vs 1983 ms (p = 0.28), starved runs 5/60 vs 5/60 (Fisher p = 1).
  Block writes cut CPU cost and change neither download nor starvation.
- **Face.** No variant meets the 33 ms frame target: the longest frame gap is 62–70 ms in all of them, and V2's
  periodic face task is about 6.7 ms worse than V1's free-running one (p = 9 × 10⁻²⁸). A gap of about two frame
  periods means a frame is occasionally skipped. The face task runs alone on core 0 at about 10 % load, so the likely
  cause is the frame itself rather than CPU contention: pushing a full 1 KB frame over I2C at 400 kHz takes at least
  23 ms, leaving little slack inside a 33 ms period (an estimate; the transfer time was not measured separately).
- **Memory.** The audio task never had less than 1772 B of its 4096 B stack free (43 % headroom); no variant
  changed heap or stack use meaningfully. The 1 MB stream buffer lives in PSRAM (7.3 MB free).

### 5.4 Reliability

5 of 600 replies were cut off by a Wi-Fi disconnect (V1: 4, V3: 1, all long clips) and are excluded above.
One session was interrupted when the phone hotspot lost its uplink; after it came back the link was slower
(91–115 kB/s per session against 136–157 kB/s before). **Starvation follows the network, not the firmware:**
starved runs downloaded at a median 68 kB/s against 148 kB/s for the rest (MWU p = 5 × 10⁻¹⁴), and the identical
V2 firmware starved 0/60 runs before the outage and 5/60 after it. A 250 ms prebuffer covers normal jitter at
≈ 150 kB/s (3 × real time) but not at ≈ 100 kB/s; P should be raised, or made adaptive to measured throughput,
if the speaker is to run on weaker links.

## 6 Threats to validity

- **Software timestamps only.** "First sound" is when the sample enters the I2S driver; the ~21 ms of ring + DMA
  buffering after it is the same for every variant.
- **Starvation is a buffer-level proxy** for an audible gap; the ~21 ms of I2S buffering hides very short gaps,
  so it is conservative.
- **Network drift.** Measurements ran over a phone hotspot whose throughput changed between sessions. CPU load is
  unaffected (V3's core-1 load was 69.6 % in both its sessions), but download time and starvation are not, so those
  are compared only within the same network period.
- **Idle-hook load method** keeps the idle task spinning (no `WAITI`), valid for timing but not for power.
- **Fixed clips through a test route** skip the cloud stages; real end-to-end latency adds STT + LLM + TTS (Fig. 4).
- **One board, one room**; RSSI was −34 to −40 dBm throughout and correlates only weakly with download time
  (Spearman ρ = −0.12).

## 7 Conclusion

The original flow is not optimal. Streaming through a FreeRTOS `StreamBuffer` with a 250 ms prebuffer makes the
time to first sound constant at about 145 ms instead of growing with the reply (up to 4.4 s for a 13 s reply) and
did not starve in 60 runs. Two further RTOS-level fixes free most of core 1: making the Arduino loop task block
instead of busy-polling (−27 points), and replacing per-sample I2S writes with block writes (another −52 points).
Raising the network task above the audio task costs CPU for at most a marginal download gain, so it is not worth it.
Audio starvation is set by the Wi-Fi link: the prebuffer must be sized for the slowest link the speaker must support.
Recommended default: **V4 (streaming, P = 250 ms, blocking loop, block I2S writes)**.

Figures: `figures/fig1_ttfs_v0_v1.pdf`, `fig2_prebuffer_sweep.pdf`, `fig3_load_face.pdf`, `fig4_latency_breakdown.pdf`.
Raw data: `data/bench.csv`, statistics: `results/stats.txt`, `results/summary.csv`.
