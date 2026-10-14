// ESPeak Hub firmware (Step 4b): Wi-Fi + WebSocket to the Worker's Durable Object (/ws).
//  - the face follows the state the server pushes: idle / listening / thinking / speaking
//    + a state glyph (top-left) and its name for 1.5 s on each change; idle > 3 s plays short "vibes";
//    asleep after 2 min idle (dim), panel off after 10 min; wakes on any event
//  - the server pushes a reply as {"type":"audio","rate":24000,"bytes":N,...} + binary PCM frames
//    (16-bit mono); we buffer the whole reply in PSRAM, then play it from a separate audio task
// RTOS benchmark builds (see ../bench/README.md), all off in the normal `speaker` env:
//   BENCH         per-reply timing/load/stack line on serial ("BENCH,...")
//   STREAMING     V1: play while downloading (StreamBuffer + prebuffer) instead of buffering the whole reply
//   NET_PRIO n    priority of the Arduino loop task (WebSocket receive), default 1
//   LOOP_YIELD    loop() blocks one tick after each ws.loop() instead of spinning
//   FACE_PERIODIC face task wakes on a fixed 33 ms period (vTaskDelayUntil) instead of polling every tick
//   BLOCK_WRITE   hand I2S 128-frame blocks instead of one sample per call (each call takes the I2S mutex)
// Test from the laptop: node test/fake_speaker.mjs (state pushes) or POST /chat meta {"target":"speaker"}.
// Credentials in src/secrets.h (gitignored): WIFI_SSID, WIFI_PASS, WORKER_HOST, APP_KEY.
#include <Arduino.h>
#include <Wire.h>
#include <WiFi.h>
#include <WebSocketsClient.h>
#include <I2S.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <FluxGarage_RoboEyes.h>
#include "secrets.h"
#ifdef STREAMING
#include <freertos/stream_buffer.h>
#endif
#ifdef BENCH
#include <esp_freertos_hooks.h>
#include <hal/cpu_hal.h>
#endif

#define OLED_SDA 14
#define OLED_SCL 13
#define I2S_BCLK_PIN 5
#define I2S_LRC_PIN  6
#define I2S_DOUT_PIN 7
#define AMP_SD_PIN   15     // MAX98357A SD: LOW = amp shut down (silent, no idle hiss), HIGH = on (left channel; we send L = R)
#define AUDIO_RATE   24000  // Orpheus output; the I2S clock is fixed to it
#define VOLUME_PCT   50     // calibration knob: scale PCM before the amp (100 = as sent)

enum State : uint8_t { OFFLINE, IDLE, LISTENING, THINKING, SPEAKING };
const char *NAMES[] = {"offline", "idle", "listening", "thinking", "speaking"};

// Dess's moods, same order/names as the Worker's MOODS; shown on the face while speaking + a 3 s hold
enum Mood : uint8_t { M_NEUTRAL, M_HAPPY, M_TIRED, M_ANGRY, M_CONFUSED, M_LAUGH };
const char *MOODS[] = {"neutral", "happy", "tired", "angry", "confused", "laugh"};
#define MOOD_HOLD_MS 3000

#ifndef NET_PRIO
#define NET_PRIO 1
#endif
#ifndef VARIANT
#define VARIANT "dev"
#endif
#ifndef PREBUF_MS
#define PREBUF_MS 250  // STREAMING: audio buffered before playback starts (P* from bench/, smallest P with no starvation)
#endif
#ifdef FACE_PERIODIC
#define FRAME_MS 33       // task period
#define FRAME_GATE_MS 30  // RoboEyes/vibes frame gate < period, so every wake draws
#else
#define FRAME_GATE_MS 33
#endif

void overlay(Adafruit_GFX &g);
void benchFrame();

// RoboEyes ends every frame with display->display(); shadowing it here lets us draw the glyph/label
// on top of the face in the same frame (no flicker, no library patch).
class Oled : public Adafruit_SSD1306 {
 public:
  using Adafruit_SSD1306::Adafruit_SSD1306;
  void display() {
    overlay(*this);
    Adafruit_SSD1306::display();
#ifdef BENCH
    benchFrame();
#endif
  }
};

Oled display(128, 64, &Wire, -1);
RoboEyes<Oled> eyes(display);
WebSocketsClient ws;
TaskHandle_t audioTaskHandle;

// state: written by ws events (loop task) and, around playback, by the audio task. Those never
// overlap in time (server pushes "thinking" before the audio and nothing during it), so no lock.
volatile uint8_t state = OFFLINE;
volatile uint8_t mood = M_HAPPY;  // set from the audio header before state flips to SPEAKING

#define VIBE_AFTER_MS 3000    // idle this long before the first vibe
#define VIBE_MS       7000    // one vibe lasts this long, then the plain face rests
#define SLEEP_MS      120000  // idle this long: eyes shut + dim (same as the app's Dess)
#define PANEL_OFF_MS  600000  // ...and this long: panel off (burn-in, power)
volatile bool asleep = false;
volatile uint32_t labelUntil = 0;
const char *volatile labelText = nullptr;

int16_t *pcm = nullptr;  // reply buffer in PSRAM; nullptr = not receiving/playing
size_t pcmBytes = 0, pcmGot = 0;
volatile bool playing = false;

#ifdef STREAMING
// V1: loop task (producer) -> StreamBuffer in PSRAM -> audio task (consumer). One writer, one reader.
#define SB_BYTES (1024 * 1024)  // ~21 s at 24 kHz: a whole reply fits, so the producer never blocks
StreamBufferHandle_t sb;
StaticStreamBuffer_t sbStatic;
volatile bool active = false;   // a reply is being received/played (header seen, not finished)
volatile bool aborted = false;  // socket dropped mid-reply
volatile long prebufMs = 0;     // from the header ("prebuf"), so one build sweeps P
#endif

#ifdef BENCH
// Per-reply measurements, printed as one CSV line after playback (never during it).
// Timestamps: esp_timer_get_time() (us since boot).
struct {
  long run, bytes, prebuf;
  int64_t head, rx, first, end;     // header in, last byte in, first sample to I2S, last sample to I2S
  uint32_t starves, maxGapUs, dry;  // stream buffer empty when audio needed it / longest wait / I2S ring found empty
  uint64_t idle0[2], idleF[2], idle1[2];  // idle cycles per core at head / first sample / end
  uint32_t frames, maxFrameUs;      // face frames drawn during head..end, longest gap between two
  int64_t lastFrame;
} B;
volatile bool benchOn = false;
int ringSize;  // I2S ring buffer bytes when empty (availableForWrite() right after begin)

// CPU load without run-time stats (off in the precompiled core): each core's idle task calls this in a
// tight loop (returning false keeps it from sleeping in WAITI), so back-to-back calls are idle time.
// A gap > 10 us means the idle task was preempted (a task or ISR ran) and is not counted.
volatile uint64_t idleCyc[2];
uint32_t lastCyc[2];
bool idleHook() {
  int c = xPortGetCoreID();
  uint32_t now = cpu_hal_get_cycle_count(), d = now - lastCyc[c];
  lastCyc[c] = now;
  if (d < 2400) idleCyc[c] += d;  // 2400 cycles = 10 us at 240 MHz
  return false;
}
uint64_t idleNow(int c) {  // 64-bit read of the other core's counter: retry until two reads agree
  uint64_t a, b;
  do { a = idleCyc[c]; b = idleCyc[c]; } while (a != b);
  return a;
}
void benchStart(long run, long bytes, long prebuf, int64_t head) {
  B = {};
  B.run = run; B.bytes = bytes; B.prebuf = prebuf; B.head = head;
  for (int c = 0; c < 2; c++) B.idle0[c] = idleNow(c);
  benchOn = true;
}
void benchFrame() {
  if (!benchOn) return;
  int64_t t = esp_timer_get_time();
  if (B.frames++ && t - B.lastFrame > B.maxFrameUs) B.maxFrameUs = t - B.lastFrame;
  B.lastFrame = t;
}
uint32_t hwm(const char *name) {  // stack bytes never used so far
  TaskHandle_t h = xTaskGetHandle(name);
  return h ? uxTaskGetStackHighWaterMark(h) : 0;
}
void benchFirst() {
  B.first = esp_timer_get_time();
  for (int c = 0; c < 2; c++) B.idleF[c] = idleNow(c);
}
double loadPct(int c, uint64_t i0, int64_t t0) {  // % of time core c was not idle from t0 to B.end
  return 100 * (1 - (B.idle1[c] - i0) / ((double)(B.end - t0) * getCpuFrequencyMhz()));
}
void benchEnd() {
  B.end = esp_timer_get_time();
  benchOn = false;
  for (int c = 0; c < 2; c++) B.idle1[c] = idleNow(c);
  // load0/1 = whole reply (header -> last sample), pload0/1 = playback only (first -> last sample)
  // variant,run,bytes,prebuf_ms,dl_ms,ttfs_ms,play_ms,starves,max_gap_ms,dry,load0,load1,pload0,pload1,frames,max_frame_ms,
  // hwm_audio,hwm_face,hwm_loop,hwm_i2s,heap_free,heap_min,psram_free,rssi
  Serial.printf("BENCH,%s,%ld,%ld,%ld,%.3f,%.3f,%.3f,%u,%.3f,%u,%.1f,%.1f,%.1f,%.1f,%u,%.3f,%u,%u,%u,%u,%u,%u,%u,%d\n",
                VARIANT, B.run, B.bytes, B.prebuf, (B.rx - B.head) / 1e3, (B.first - B.head) / 1e3, (B.end - B.first) / 1e3,
                B.starves, B.maxGapUs / 1e3, B.dry, loadPct(0, B.idle0[0], B.head), loadPct(1, B.idle0[1], B.head),
                loadPct(0, B.idleF[0], B.first), loadPct(1, B.idleF[1], B.first), B.frames, B.maxFrameUs / 1e3,
                hwm("audio"), hwm("face"), hwm("loopTask"), hwm("onDmaTransferCo"),
                ESP.getFreeHeap(), ESP.getMinFreeHeap(), ESP.getFreePsram(), WiFi.RSSI());
}
#define BENCH_DO(x) x
#else
#define BENCH_DO(x)
#endif

// one mono sample out to I2S as L = R
#ifdef BLOCK_WRITE
int16_t blk[256];  // 128 stereo frames = one I2S DMA buffer
int nblk = 0;
inline void out(int16_t s) {
  blk[nblk++] = s;
  blk[nblk++] = s;
  if (nblk == 256) { I2S.write_blocking(blk, sizeof blk); nblk = 0; }
}
inline void outFlush() { if (nblk) { I2S.write_blocking(blk, nblk * 2); nblk = 0; } }
#else
inline void out(int16_t s) {
  I2S.write(s);  // blocks when the ring buffer is full; mono -> same sample on L and R
  I2S.write(s);
}
inline void outFlush() {}
#endif

void apply(uint8_t s) {
  uint8_t m = s == OFFLINE ? M_TIRED : s == SPEAKING ? mood : M_NEUTRAL;
  // RoboEyes has 4 moods; confused/laugh are one-shot shake animations, triggered in faceTask
  eyes.setMood(m == M_HAPPY || m == M_LAUGH ? HAPPY : m == M_TIRED ? TIRED : m == M_ANGRY ? ANGRY : DEFAULT);
  eyes.setPosition(s == THINKING ? NE : DEFAULT);
  eyes.setHeight(s == LISTENING ? 48 : 36, s == LISTENING ? 48 : 36);  // wide eyes = "I'm listening"
  eyes.setIdleMode(s == IDLE || s == SPEAKING || s == OFFLINE, 2, 2);
}

// ---- state glyph (top-left 14x14 on a black backing) + its name along the bottom for a moment ----
void overlay(Adafruit_GFX &g) {
  uint32_t now = millis();
  uint8_t s = state;
  g.setTextSize(1);
  g.setTextColor(WHITE);
  if (asleep) {
    for (int i = 0; i < 3; i++) {  // floating z z z
      uint32_t ph = (now / 30 + i * 33) % 100;
      g.setTextSize(ph > 50 ? 2 : 1);
      g.setCursor(84 + ph / 5, 44 - ph / 3);
      g.print('z');
    }
    return;
  }
  if (s != IDLE) {
    g.fillRect(0, 0, 14, 14, BLACK);
    if (s == LISTENING) {  // mic
      g.fillRoundRect(5, 0, 4, 8, 2, WHITE);
      g.drawCircleHelper(7, 5, 5, 0xC, WHITE);
      g.drawFastVLine(7, 10, 3, WHITE);
      g.drawFastHLine(4, 13, 7, WHITE);
    } else if (s == THINKING) {  // three dots, one hops
      for (int i = 0; i < 3; i++) g.fillCircle(2 + i * 5, 8 - (now / 250 % 3 == (uint32_t)i ? 3 : 0), 1, WHITE);
    } else if (s == SPEAKING) {  // speaker + waves
      g.fillRect(0, 5, 3, 5, WHITE);
      g.fillTriangle(3, 7, 7, 2, 7, 13, WHITE);
      g.drawCircleHelper(8, 7, 3, 0x6, WHITE);
      if (now / 300 % 2) g.drawCircleHelper(8, 7, 6, 0x6, WHITE);
    } else {  // OFFLINE: Wi-Fi arcs sweep while connecting; steady + a cross once Wi-Fi is up but the cloud isn't
      bool wifi = WiFi.status() == WL_CONNECTED;
      int shown = wifi ? 3 : (int)(now / 300 % 4);
      for (int i = 0; i < shown; i++) g.drawCircleHelper(7, 13, 3 + i * 3, 0x3, WHITE);
      g.fillCircle(7, 13, 1, WHITE);
      if (wifi) {
        g.drawLine(9, 8, 13, 12, WHITE);
        g.drawLine(13, 8, 9, 12, WHITE);
      }
    }
  }
  if (now < labelUntil && labelText) {
    g.fillRect(0, 55, 128, 9, BLACK);
    g.setCursor((128 - 6 * strlen(labelText)) / 2, 56);
    g.print(labelText);
  }
}

// ---- idle vibes: drawn straight on the panel while RoboEyes is paused ----
void eyePair(int dx, int dy, int w, int h, bool happy) {
  int x = (128 - (2 * w + 10)) / 2 + dx, y = (64 - h) / 2 + dy;
  for (int i = 0; i < 2; i++) {
    int ex = x + i * (w + 10);
    display.fillRoundRect(ex, y, w, h, 8, WHITE);
    if (happy) display.fillRoundRect(ex - 3, y + h * 55 / 100, w + 6, h, 10, BLACK);  // lower lid up = ^ ^ squint
  }
}

void sparkle(int x, int y, int r) {
  display.drawFastHLine(x - r, y, 2 * r + 1, WHITE);
  display.drawFastVLine(x, y - r, 2 * r + 1, WHITE);
}

#define NVIBES 4
void vibeFrame(int id, uint32_t t) {
  display.clearDisplay();
  float ft = t;
  if (id == 0) {  // bouncing to a beat, notes float up the sides
    eyePair(0, 2 - (int)(fabsf(sinf(PI * ft / 500)) * 7), 36, 32, true);
    const int xs[3] = {8, 112, 121};
    for (int i = 0; i < 3; i++) {
      int x = xs[i] + (int)(sinf(ft / 200 + i) * 3), y = 62 - (int)((t / 18 + i * 37) % 64);
      display.fillCircle(x, y, 2, WHITE);
      display.drawFastVLine(x + 2, y - 7, 7, WHITE);
      display.drawLine(x + 2, y - 7, x + 5, y - 5, WHITE);
    }
  } else if (id == 1) {  // equalizer along the bottom
    eyePair(0, -14, 36, 28, false);
    for (int i = 0; i < 16; i++) {
      int h = 3 + (int)((sinf(ft / 90 + i * 0.8f) + sinf(ft / 137 + i * 1.7f) + 2) * 4.5f);
      display.fillRect(4 + i * 8, 63 - h, 6, h, WHITE);
    }
  } else if (id == 2) {  // sunglasses slide in, hold, slide out
    float k = t < 700 ? ft / 700 : (t > VIBE_MS - 700 ? (VIBE_MS - ft) / 700 : 1);
    k = 1 - (1 - k) * (1 - k);
    int y = 19 - (int)((1 - k) * 46);
    eyePair(0, 0, 36, 26, false);
    for (int i = 0; i < 2; i++) {
      int x = 19 + i * 46;
      display.fillRoundRect(x, y, 44, 26, 9, WHITE);
      display.drawLine(x + 10, y + 22, x + 22, y + 4, BLACK);
      display.drawLine(x + 15, y + 22, x + 27, y + 4, BLACK);
    }
    display.drawLine(19, y + 6, 0, y + 2, WHITE);
    display.drawLine(109, y + 6, 127, y + 2, WHITE);
  } else {  // happy sway with twinkles
    eyePair((int)(sinf(ft / 380) * 16), (int)(sinf(ft / 190) * 2), 36, 34, true);
    const int px[5] = {14, 112, 20, 108, 64}, py[5] = {10, 14, 54, 50, 5};
    for (int i = 0; i < 5; i++) sparkle(px[i], py[i], 1 + (int)((sinf(ft / 140 + i * 1.3f) + 1) * 2.5f));
  }
  display.display();
}

void wake() {
  asleep = false;
  display.ssd1306_command(SSD1306_DISPLAYON);
  display.dim(false);
  eyes.setAutoblinker(ON, 3, 2);
  eyes.open();
}

void faceTask(void *) {
  uint8_t last = 255;
  uint32_t nextShake = 0, idleSince = millis(), nextVibe = 0, vibeAt = 0, lastFrame = 0, bootAt = millis();
  bool panelOff = false, woke = false;
  int vibe = -1, lastVibe = -1;
#ifdef FACE_PERIODIC
  TickType_t wakeAt = xTaskGetTickCount();
#define FACE_WAIT() vTaskDelayUntil(&wakeAt, pdMS_TO_TICKS(FRAME_MS))
#else
#define FACE_WAIT() vTaskDelay(1)
#endif
  for (;;) {
    uint32_t now = millis();
    if (state != last) {
      bool first = last == 255;
      last = state;
      apply(last);
      if (first) eyes.close();  // power-on: a thin line, opened below
      else if (asleep) {
        wake();
        panelOff = false;
      }
      idleSince = now;
      nextVibe = now + VIBE_AFTER_MS;
      vibe = -1;
      nextShake = 0;
      if (last != IDLE) {  // flash the state's name for a moment
        labelText = last == OFFLINE ? (WiFi.status() == WL_CONNECTED ? "OFFLINE" : "CONNECTING") : last == LISTENING ? "LISTENING" : last == THINKING ? "THINKING" : "SPEAKING";
        labelUntil = now + 1500;
      }
      if (last == SPEAKING) Serial.printf("face: speaking / %s\n", MOODS[mood]);
      else Serial.printf("face: %s\n", NAMES[last]);
    }
    if (!woke && now - bootAt > 700) {  // eyes open after a beat
      woke = true;
      eyes.open();
      eyes.setAutoblinker(ON, 3, 2);
    }
    if (last == IDLE && woke) {
      uint32_t idle = now - idleSince;
      if (!asleep && idle > SLEEP_MS) {  // eyes shut, dim, z z z
        asleep = true;
        vibe = -1;
        eyes.setAutoblinker(OFF);
        eyes.setIdleMode(OFF);
        eyes.close();
        display.dim(true);
      }
      if (asleep && !panelOff && idle > PANEL_OFF_MS) {
        panelOff = true;
        display.ssd1306_command(SSD1306_DISPLAYOFF);
      }
      if (!asleep) {
        if (vibe < 0 && now >= nextVibe) {
          do vibe = random(NVIBES); while (vibe == lastVibe);
          lastVibe = vibe;
          vibeAt = now;
        }
        if (vibe >= 0) {
          if (now - vibeAt > VIBE_MS) {
            vibe = -1;
            nextVibe = now + random(10000, 25000);
          } else {
            if (now - lastFrame >= FRAME_GATE_MS) {
              lastFrame = now;
              vibeFrame(vibe, now - vibeAt);
            }
            FACE_WAIT();
            continue;
          }
        }
      }
    }
    // confused/laugh are one-shot shakes (~0.5 s), so repeat them while the reply plays
    if (last == SPEAKING && (mood == M_CONFUSED || mood == M_LAUGH) && now >= nextShake) {
      mood == M_CONFUSED ? eyes.anim_confused() : eyes.anim_laugh();
      nextShake = now + 1500;
    }
    if (!panelOff) eyes.update();
    FACE_WAIT();
  }
}

#ifdef BENCH
// I2S ring found empty = the library's DMA task had nothing to refill DMA with (DMA then repeats old data)
#define CHECK_DRY() if (I2S.availableForWrite() >= ringSize) B.dry++
#endif

#ifndef STREAMING
// V0: woken once the whole reply is in PSRAM, then plays it
void audioTask(void *) {
  for (;;) {
    ulTaskNotifyTake(pdTRUE, portMAX_DELAY);  // woken when a whole reply has arrived
    uint32_t t0 = millis();
    state = SPEAKING;
    digitalWrite(AMP_SD_PIN, HIGH);
    vTaskDelay(30 / portTICK_PERIOD_MS);  // let the amp wake up before the first sample
    size_t n = pcmBytes / 2;
    BENCH_DO(benchFirst());
    for (size_t i = 0; i < n; i++) {
      BENCH_DO(if (i % 512 == 256) CHECK_DRY());
      out((int32_t)pcm[i] * VOLUME_PCT / 100);
    }
    outFlush();
    BENCH_DO(benchEnd());
    for (int i = 0; i < AUDIO_RATE / 5; i++) out(0);  // 200 ms tail: let the DMA drain, no click
    outFlush();
    digitalWrite(AMP_SD_PIN, LOW);  // mute until the next reply
    Serial.printf("audio: played %u samples in %u ms\n", (unsigned)n, (unsigned)(millis() - t0));
    free(pcm);
    pcm = nullptr;
    playing = false;
    vTaskDelay(MOOD_HOLD_MS / portTICK_PERIOD_MS);  // keep the mood face a moment after the last word
    if (state == SPEAKING) state = IDLE;            // unless a new turn already moved the face on
  }
}

void dropReply() {
  if (!playing && pcm) { free(pcm); pcm = nullptr; }
}
#else
// V1: woken by the header, waits until `prebufMs` of audio is buffered (or the whole reply, if shorter),
// then plays while the rest is still arriving. The producer notifies after every frame: no polling.
uint8_t chunk[1024];  // 512 samples = 21 ms; static, not on the 4 KB task stack
void audioTask(void *) {
  for (;;) {
    ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
    if (!active) continue;  // a leftover per-frame notification from the last reply
    uint32_t t0 = millis();
    // P = 0 means "start on the first frame", so the first receive below always finds data
    size_t total = pcmBytes, used = 0, want = max((size_t)2, min((size_t)(prebufMs * AUDIO_RATE / 1000) * 2, total));
    while (!aborted && xStreamBufferBytesAvailable(sb) < want) ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(3000));
    state = SPEAKING;
    digitalWrite(AMP_SD_PIN, HIGH);
    vTaskDelay(30 / portTICK_PERIOD_MS);  // let the amp wake up before the first sample
    BENCH_DO(benchFirst());
    while (used < total && !aborted) {
      size_t n = xStreamBufferReceive(sb, chunk, min(sizeof chunk, total - used), 0);
      if (!n) {  // starved: nothing buffered although the reply is not finished
        BENCH_DO(B.starves++; int64_t ts = esp_timer_get_time());
        n = xStreamBufferReceive(sb, chunk, min(sizeof chunk, total - used), pdMS_TO_TICKS(3000));
        BENCH_DO(uint32_t gap = esp_timer_get_time() - ts; if (gap > B.maxGapUs) B.maxGapUs = gap);
        if (!n) break;  // 3 s of nothing: give up on this reply
      }
      BENCH_DO(CHECK_DRY());
      const int16_t *s = (const int16_t *)chunk;
      for (size_t i = 0; i < n / 2; i++) out((int32_t)s[i] * VOLUME_PCT / 100);
      used += n;
    }
    outFlush();
    BENCH_DO(benchEnd());
    for (int i = 0; i < AUDIO_RATE / 5; i++) out(0);  // 200 ms tail: let the DMA drain, no click
    outFlush();
    digitalWrite(AMP_SD_PIN, LOW);  // mute until the next reply
    Serial.printf("audio: played %u samples in %u ms\n", (unsigned)(used / 2), (unsigned)(millis() - t0));
    xStreamBufferReset(sb);  // drop leftovers of an aborted reply (nobody is blocked on sb here)
    active = false;
    vTaskDelay(MOOD_HOLD_MS / portTICK_PERIOD_MS);  // keep the mood face a moment after the last word
    if (state == SPEAKING) state = IDLE;            // unless a new turn already moved the face on
  }
}

void dropReply() {
  if (active) { aborted = true; xTaskNotifyGive(audioTaskHandle); }
}
#endif

// ponytail: substring parsing of our own fixed-shape messages; use ArduinoJson once they get richer
long field(const char *msg, const char *key) {
  const char *p = strstr(msg, key);
  return p ? atol(p + strlen(key)) : -1;
}

// sets `mood` from a "mood":"x" field; false if the message has none
bool readMood(const char *msg) {
  const char *m = strstr(msg, "\"mood\":\"");
  for (uint8_t i = 0; m && i < sizeof MOODS / sizeof *MOODS; i++)
    if (!strncmp(m + 8, MOODS[i], strlen(MOODS[i]))) { mood = i; return true; }
  return false;
}

void onEvent(WStype_t type, uint8_t *payload, size_t len) {
  if (type == WStype_CONNECTED) {
    Serial.println("ws: connected");
    state = IDLE;
  } else if (type == WStype_DISCONNECTED) {
    Serial.println("ws: disconnected");
    dropReply();
    state = OFFLINE;
  } else if (type == WStype_TEXT) {
    BENCH_DO(int64_t tHead = esp_timer_get_time());  // before the serial print below
    Serial.printf("ws: %.*s\n", (int)len, payload);
    const char *msg = (const char *)payload;
    if (strstr(msg, "\"type\":\"audio\"")) {
      long rate = field(msg, "\"rate\":"), bytes = field(msg, "\"bytes\":");
#ifdef STREAMING
      bool busy = active;
#else
      bool busy = playing;
#endif
      if (busy || rate != AUDIO_RATE || bytes <= 0) {
        Serial.printf("audio: ignored (busy=%d rate=%ld bytes=%ld)\n", busy, rate, bytes);
        return;
      }
      if (!readMood(msg)) mood = M_HAPPY;  // fallback, same as the Worker's
      long prebuf = field(msg, "\"prebuf\":");  // only sent by POST /bench
      BENCH_DO(benchStart(field(msg, "\"run\":"), bytes, prebuf, tHead));
#ifdef STREAMING
      pcmBytes = bytes & ~1L;
      pcmGot = 0;
      prebufMs = prebuf < 0 ? PREBUF_MS : prebuf;
      aborted = false;
      active = true;
      xTaskNotifyGive(audioTaskHandle);  // starts the prebuffer wait
#else
      (void)prebuf;
      dropReply();
      pcm = (int16_t *)ps_malloc(bytes);
      pcmBytes = bytes;
      pcmGot = 0;
      if (!pcm) Serial.printf("audio: ps_malloc(%ld) failed\n", bytes);
#endif
      return;
    }
    readMood(msg);  // POST /state may carry a mood too (used for testing faces)
    for (uint8_t s = IDLE; s <= SPEAKING; s++) {
      char want[32];
      snprintf(want, sizeof want, "\"state\":\"%s\"", NAMES[s]);
      if (strstr(msg, want)) state = s;
    }
#ifdef STREAMING
  } else if (type == WStype_BIN && active && pcmGot < pcmBytes) {
    if (pcmGot + len > pcmBytes) len = pcmBytes - pcmGot;
    xStreamBufferSend(sb, payload, len, pdMS_TO_TICKS(3000));  // blocks only if 1 MB is full (backpressure)
    pcmGot += len;
    if (pcmGot == pcmBytes) {
      BENCH_DO(B.rx = esp_timer_get_time());
      Serial.printf("audio: received %u bytes\n", (unsigned)pcmBytes);
    }
    xTaskNotifyGive(audioTaskHandle);  // "more data": wakes the prebuffer wait
  }
#else
  } else if (type == WStype_BIN && pcm && !playing) {
    if (pcmGot + len > pcmBytes) len = pcmBytes - pcmGot;
    memcpy((uint8_t *)pcm + pcmGot, payload, len);
    pcmGot += len;
    if (pcmGot == pcmBytes) {
      BENCH_DO(B.rx = esp_timer_get_time());
      Serial.printf("audio: received %u bytes\n", (unsigned)pcmBytes);
      playing = true;
      xTaskNotifyGive(audioTaskHandle);
    }
  }
#endif
}

void setup() {
  Serial.begin(115200);
  Wire.begin(OLED_SDA, OLED_SCL);
  if (!display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {
    Serial.println("SSD1306 init failed");
    for (;;) delay(1000);
  }
  display.ssd1306_command(SSD1306_DISPLAYON);
  display.dim(false);
  eyes.begin(128, 64, 1000 / FRAME_GATE_MS);  // 30 fps; FACE_PERIODIC: 33 fps gate under a 33 ms task period
  eyes.setAutoblinker(OFF);  // faceTask turns it on after the power-on wake-up

  pinMode(AMP_SD_PIN, OUTPUT);
  digitalWrite(AMP_SD_PIN, LOW);  // amp off from the start: nothing to hear while booting / on Wi-Fi
  I2S.setAllPins(I2S_BCLK_PIN, I2S_LRC_PIN, I2S_DOUT_PIN, I2S_DOUT_PIN, I2S_DOUT_PIN);
  if (!I2S.begin(I2S_PHILIPS_MODE, AUDIO_RATE, 16)) {
    Serial.println("Failed to start I2S");
    for (;;) delay(1000);
  }
  // Prime the DMA with silence: nothing writes to I2S until the first reply, so the amp would keep playing
  // whatever the buffers held (noise after every reset, gone after the first reply's silent tail). 0.5 s > DMA depth.
  BENCH_DO(ringSize = I2S.availableForWrite());
  for (int i = 0; i < AUDIO_RATE / 2; i++) { I2S.write((int16_t)0); I2S.write((int16_t)0); }
#ifdef STREAMING
  sb = xStreamBufferCreateStatic(SB_BYTES, 1, (uint8_t *)ps_malloc(SB_BYTES + 1), &sbStatic);
#endif
#ifdef BENCH
  for (int c = 0; c < 2; c++) esp_register_freertos_idle_hook_for_cpu(idleHook, c);
#endif
  vTaskPrioritySet(nullptr, NET_PRIO);  // we are the Arduino loop task, which runs ws.loop()
  Serial.printf("variant %s, net prio %d\n", VARIANT, NET_PRIO);
  xTaskCreatePinnedToCore(audioTask, "audio", 4096, nullptr, 3, &audioTaskHandle, 1);
  xTaskCreatePinnedToCore(faceTask, "face", 8192, nullptr, 1, nullptr, 0);

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.printf("wifi: connecting to \"%s\"\n", WIFI_SSID);
  while (WiFi.status() != WL_CONNECTED) delay(250);
  Serial.printf("wifi: ip=%s rssi=%d dBm psram_free=%u\n", WiFi.localIP().toString().c_str(), WiFi.RSSI(), ESP.getFreePsram());

  // ponytail: beginSSL without a CA/fingerprint does not verify the server cert (the key is still
  // encrypted on the wire); pin Cloudflare's root CA if this ever leaves a trusted hotspot.
  ws.setExtraHeaders("X-App-Key: " APP_KEY);
  ws.beginSSL(WORKER_HOST, 443, "/ws");
  ws.onEvent(onEvent);
  ws.setReconnectInterval(3000);
  ws.enableHeartbeat(15000, 3000, 2);  // ping every 15 s, drop + reconnect after 2 missed pongs
}

#ifdef LOOP_YIELD
// The Arduino loop task never blocks on its own: without this it spins at 100 % of core 1 and the idle task never runs
void loop() {
  ws.loop();
  vTaskDelay(1);
}
#else
void loop() { ws.loop(); }
#endif
