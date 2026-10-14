// ESPeak Hub - speaker firmware (ESP32-S3), Arduino IDE version of firmware/src/speaker.cpp (variant V4).
//
// What it does: the phone app records your voice and sends it to a Cloudflare Worker, which does
// speech-to-text, an LLM answer and text-to-speech. The Worker pushes the spoken reply to THIS
// board over a WebSocket; the board plays it through an I2S amplifier and shows what is going on
// as an animated face (Dess) on a small OLED. Read README.md next to this file for the full picture.
//
// The sketch is split into tabs, one per job:
//   speaker.ino  this tab: setup() starts everything, creates the three FreeRTOS tasks
//   net.ino      Wi-Fi + WebSocket, turns server messages into state / audio calls
//   audio.ino    reply buffer (StreamBuffer in PSRAM) + the task that plays it on I2S
//   face.ino     OLED: eyes, state glyphs, idle "vibes", sleep
//   shared.h     pins, tuning knobs, state/mood names, what the tabs share
//
// Three tasks run concurrently (FreeRTOS, the ESP32-S3 has two cores):
//
//   core 0   faceTask   priority 1   draws the face at ~33 fps
//   core 1   audioTask  priority 3   waits for audio, plays it (highest: must never be late)
//   core 1   loopTask   priority 1   Arduino's loop(): pumps the WebSocket (receives audio)
//
// Needs ESP32 core 2.0.17, board "ESP32S3 Dev Module", PSRAM = OPI (see README.md).
#include "shared.h"

// state: what the face shows. mood: which expression while speaking. See shared.h.
volatile uint8_t state = OFFLINE;
volatile uint8_t mood = M_HAPPY;

void setup() {
  Serial.begin(115200);
  faceBegin();    // OLED + eyes (halts with a message if the OLED is not found)
  audioBegin();   // I2S + the 1 MB reply buffer in PSRAM (halts if I2S fails)

  // Audio is pinned to core 1 at priority 3 so a busy Wi-Fi stack or a slow frame draw can never
  // starve it. The face runs on core 0 at priority 1: it only has to look smooth, not be on time.
  xTaskCreatePinnedToCore(audioTask, "audio", 4096, nullptr, 3, &audioTaskHandle, 1);
  xTaskCreatePinnedToCore(faceTask, "face", 8192, nullptr, 1, nullptr, 0);

  netBegin();     // blocks until Wi-Fi is up (face shows "CONNECTING"), then opens the WebSocket
}

void loop() {
  netLoop();
  // The Arduino loop task never blocks by itself: without this delay it spins at 100 % of core 1
  // and the idle task never runs. One tick (1 ms) of sleep per pass is enough to let it breathe.
  // Together with block I2S writes (audio.ino) this took core-1 load while playing from 92.8 %
  // to 14.5 % in the RTOS study (bench/REPORT_section.md, variants V1 -> V4).
  vTaskDelay(1);
}
