// audio.ino - receive a reply into a buffer and play it on the I2S amplifier while it is still arriving.
//
//   WebSocket frames --audioPush()--> StreamBuffer (1 MB, PSRAM) --audioTask--> I2S --> MAX98357A --> speaker
//        (loop task, producer)                                  (consumer, core 1, priority 3)
//
// Why a StreamBuffer and not "download everything, then play": the download runs at ~3x real time
// here, so waiting for the whole reply costs 0.7 s for a 2 s answer and 4.4 s for a 13 s one. Starting after
// PREBUF_MS (250 ms) of audio makes the wait ~145 ms whatever the length (RTOS study, bench/REPORT_section.md).
// There is exactly one writer (net.ino) and one reader (audioTask), which is what StreamBuffer is built for.
#include "shared.h"

TaskHandle_t audioTaskHandle;

static StreamBufferHandle_t sb;
static StaticStreamBuffer_t sbStatic;
static volatile bool active = false;   // a reply is being received/played (header seen, not finished)
static volatile bool aborted = false;  // socket dropped mid-reply
static size_t pcmBytes = 0, pcmGot = 0;  // announced size of this reply / bytes received so far

// ---------------------------------------------------------------- I2S output
// One mono sample goes out as L = R. Samples are collected into a 128-frame block and handed to
// the driver at once: the Arduino I2S library takes a mutex per call, so a call per sample kept
// core 1 busy 66 % of the time, a call per block 14.5 % (study variants V2 -> V4).
static int16_t blk[256];  // 128 stereo frames = one I2S DMA buffer
static int nblk = 0;
static inline void out(int16_t s) {
  blk[nblk++] = s;
  blk[nblk++] = s;
  if (nblk == 256) { I2S.write_blocking(blk, sizeof blk); nblk = 0; }  // blocks while the DMA is full: that is our pacing
}
static inline void outFlush() { if (nblk) { I2S.write_blocking(blk, nblk * 2); nblk = 0; } }

void audioBegin() {
  pinMode(AMP_SD_PIN, OUTPUT);
  digitalWrite(AMP_SD_PIN, LOW);  // amp off from the start: nothing to hear while booting / on Wi-Fi
  I2S.setAllPins(I2S_BCLK_PIN, I2S_LRC_PIN, I2S_DOUT_PIN, I2S_DOUT_PIN, I2S_DOUT_PIN);
  if (!I2S.begin(I2S_PHILIPS_MODE, AUDIO_RATE, 16)) {
    Serial.println("Failed to start I2S");
    for (;;) delay(1000);
  }
  // Prime the DMA with silence: nothing writes to I2S until the first reply, so the amp would keep
  // playing whatever the buffers held (noise after every reset). 0.5 s is longer than the DMA depth.
  for (int i = 0; i < AUDIO_RATE / 2; i++) { I2S.write((int16_t)0); I2S.write((int16_t)0); }
  sb = xStreamBufferCreateStatic(SB_BYTES, 1, (uint8_t *)ps_malloc(SB_BYTES + 1), &sbStatic);
}

// ---------------------------------------------------------------- called from net.ino (loop task)
bool audioBusy() { return active; }

void audioStart(long bytes) {   // header seen: remember the size, wake the audio task
  pcmBytes = bytes & ~1L;       // whole 16-bit samples only
  pcmGot = 0;
  aborted = false;
  active = true;
  xTaskNotifyGive(audioTaskHandle);
}

void audioPush(const uint8_t *data, size_t len) {  // one binary frame
  if (!active || pcmGot >= pcmBytes) return;
  if (pcmGot + len > pcmBytes) len = pcmBytes - pcmGot;
  xStreamBufferSend(sb, data, len, pdMS_TO_TICKS(3000));  // blocks only if the 1 MB is full (backpressure)
  pcmGot += len;
  if (pcmGot == pcmBytes) Serial.printf("audio: received %u bytes\n", (unsigned)pcmBytes);
  xTaskNotifyGive(audioTaskHandle);  // "more data": wakes the prebuffer wait. No polling.
}

void audioAbort() {
  if (active) { aborted = true; xTaskNotifyGive(audioTaskHandle); }
}

// ---------------------------------------------------------------- the playback task (core 1, priority 3)
static uint8_t chunk[1024];  // 512 samples = 21 ms; static, not on the 4 KB task stack

void audioTask(void *) {
  for (;;) {
    ulTaskNotifyTake(pdTRUE, portMAX_DELAY);  // sleep until a header (or a frame) arrives
    if (!active) continue;                    // a leftover per-frame notification from the last reply
    uint32_t t0 = millis();

    // 1. Wait until PREBUF_MS of audio is buffered (or the whole reply, if it is shorter).
    size_t total = pcmBytes, used = 0;
    size_t want = max((size_t)2, min((size_t)(PREBUF_MS * AUDIO_RATE / 1000) * 2, total));
    while (!aborted && xStreamBufferBytesAvailable(sb) < want) ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(3000));

    // 2. Switch the amp on and let the face show the mood.
    state = SPEAKING;
    digitalWrite(AMP_SD_PIN, HIGH);
    vTaskDelay(30 / portTICK_PERIOD_MS);      // let the amp wake up before the first sample

    // 3. Play: take up to 21 ms from the buffer, scale the volume, hand it to I2S.
    while (used < total && !aborted) {
      size_t n = xStreamBufferReceive(sb, chunk, min(sizeof chunk, total - used), 0);
      if (!n) {  // starved: nothing buffered although the reply is not finished (Wi-Fi too slow)
        n = xStreamBufferReceive(sb, chunk, min(sizeof chunk, total - used), pdMS_TO_TICKS(3000));
        if (!n) break;                        // 3 s of nothing: give up on this reply
      }
      const int16_t *s = (const int16_t *)chunk;
      for (size_t i = 0; i < n / 2; i++) out((int32_t)s[i] * VOLUME_PCT / 100);
      used += n;
    }
    outFlush();

    // 4. Tail of silence so the DMA drains without a click, then mute the amp.
    for (int i = 0; i < AUDIO_RATE / 5; i++) out(0);   // 200 ms
    outFlush();
    digitalWrite(AMP_SD_PIN, LOW);
    Serial.printf("audio: played %u samples in %u ms\n", (unsigned)(used / 2), (unsigned)(millis() - t0));

    xStreamBufferReset(sb);  // drop leftovers of an aborted reply (nobody is blocked on sb here)
    active = false;
    vTaskDelay(MOOD_HOLD_MS / portTICK_PERIOD_MS);  // keep the mood face a moment after the last word
    if (state == SPEAKING) state = IDLE;            // unless a new turn already moved the face on
  }
}
