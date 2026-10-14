# ESPeak Hub firmware, Arduino IDE edition

Same firmware as `../firmware/src/speaker.cpp` (PlatformIO, variant **V4** from the RTOS study), reorganised
into readable tabs for the Arduino IDE. The PlatformIO project is untouched and still holds the benchmark builds.

| Sketch | What it is |
|---|---|
| `speaker/` | **The firmware.** Open `speaker/speaker.ino`. |
| `oled_scan/` | I2C scanner: expect `found 0x3C`. Use it first when the OLED shows nothing. |
| `tone_test/` | 444 Hz test tone, amplifier check (older, standalone). |

## How the system works (what to read first)

```
 phone app --audio--> Cloudflare Worker --> Groq: speech-to-text -> LLM answer -> text-to-speech
                           |
                    Durable Object  (one per speaker, holds the WebSocket)
                           |   wss: JSON state messages + binary PCM frames (8 KB each)
                           v
                 ESP32-S3 (this firmware) --> I2S --> MAX98357A amp --> speaker
                           |
                         SSD1306 OLED: Dess's face (listening / thinking / speaking + mood)
```

The board never talks to the AI services. It is a **thin client**: it keeps a WebSocket open to the Worker and
does exactly two things with what arrives: change the face, and play audio.

### Tabs in `speaker/`

| Tab | Job | Read it for |
|---|---|---|
| `speaker.ino` | `setup()` and `loop()` | the big picture, and the three FreeRTOS tasks being created |
| `net.ino` | Wi-Fi + WebSocket | the message protocol (what the server sends and how it is routed) |
| `audio.ino` | reply buffer + playback | the producer/consumer design and why it is fast |
| `face.ino` | OLED animation | how state and mood become a face; sleep and idle behaviour |
| `shared.h` | pins, knobs, names | every tunable number in one place |

### Tasks and cores

| Task | Core | Priority | Does |
|---|---|---|---|
| `audioTask` | 1 | 3 (highest) | waits for audio, plays it on I2S. Must never be late, so it outranks everything. |
| `loopTask` (`loop()`) | 1 | 1 | pumps the WebSocket: receives text and PCM frames, hands them on |
| `faceTask` | 0 | 1 | draws the face at ~33 fps. Needs to look smooth, not be punctual. |

Wi-Fi and TCP/IP run on core 0 inside the ESP32 SDK. Putting audio on the other core keeps network bursts from
delaying playback.

### One spoken reply, step by step

1. The Worker sends a text header `{"type":"audio","rate":24000,"bytes":N,"mood":"happy"}` (`net.ino`).
2. `audioStart()` records the size and wakes `audioTask`; PCM frames start arriving and `audioPush()` puts each into a
   1 MB `StreamBuffer` in PSRAM.
3. `audioTask` waits until 250 ms of audio is buffered, then switches the amp on, sets `state = SPEAKING` and plays
   while the rest is still downloading. The face shows the reply's mood.
4. After the last sample it plays 200 ms of silence (no click), mutes the amp, holds the mood face 3 s, then goes idle.

### Why this design (numbers from the RTOS study, `../bench/REPORT_section.md`)

* **Streaming instead of buffering the whole reply:** time to first sound went from 669 / 1307 / 4403 ms (2 / 4 / 13 s replies)
  to about 145 ms regardless of length.
* **Prebuffer 250 ms:** the smallest value with no buffer starvation on the test network.
* **`vTaskDelay(1)` in `loop()` and block writes to I2S:** playback load on core 1 fell from 92.8 % to 14.5 %.
* **No lock on `state`/`mood`:** they are plain `volatile` variables, because the server's message order guarantees
  the network code and the audio task never write them at the same moment.

## Build it in the Arduino IDE

### One-time setup

1. Arduino IDE 2.x. **File → Preferences → Additional boards manager URLs**, add
   `https://espressif.github.io/arduino-esp32/package_esp32_index.json`
2. **Boards Manager** → search `esp32` → install **"esp32 by Espressif Systems" 2.0.17**.
   It must be **2.0.17**: the sketches use `<I2S.h>`, which core 3.x removed. Don't let the IDE update it.
3. **Library Manager**, install:
   * `Adafruit SSD1306` (accept the dependencies `Adafruit GFX Library` and `Adafruit BusIO`)
   * `FluxGarage RoboEyes`
   * `WebSockets` by Markus Sattler (2.7.x)
4. In `speaker/`, copy `secrets.h.example` to `secrets.h` and fill in Wi-Fi name, password, Worker host and app key.
   (`secrets.h` is gitignored; it already exists here, copied from the PlatformIO project.)

### Tools menu

| Setting | Value |
|---|---|
| Board | **ESP32S3 Dev Module** |
| USB CDC On Boot | **Disabled**: `Serial` goes out the UART/CH343 port (COM17), not the native USB port |
| USB Mode | Hardware CDC and JTAG (default) |
| Flash Size | 8MB (N8R8 board) |
| PSRAM | **OPI PSRAM**: required, the reply buffer lives in PSRAM; wrong setting = boot loop |
| Partition Scheme | Default 4MB with spiffs |
| Upload Speed | 921600 (115200 if uploads fail) |
| Port | the COM port of the board's **UART** USB connector (COM17 here) |

### Run it

1. Open `speaker/speaker.ino`, set the Tools menu as above, **Upload**.
2. **Serial Monitor** at **115200**. Expect `wifi: connecting…`, then `wifi: ip=…`, then `ws: connected`.
3. Send a spoken turn from the app with the **speaker** target. For state pushes only, use
   `backend/hello-worker/test/fake_speaker.mjs` (not while the board is online, the Worker keeps one socket).

### Tuning knobs (`shared.h`)

`VOLUME_PCT` (loudness), `PREBUF_MS` (start-up delay vs. risk of cut-outs), `MOOD_HOLD_MS`, the pin numbers.

### If upload fails

Hold **BOOT**, tap **RESET**, release **BOOT** (download mode), upload again. Use the UART USB-C port, not the other.
