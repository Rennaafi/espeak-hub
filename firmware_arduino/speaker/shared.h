// shared.h - what every tab of the sketch agrees on: libraries, pins, tuning knobs, the state
// machine's vocabulary, and the few variables that cross from one task to another.
#pragma once
#include <Arduino.h>
#include <Wire.h>
#include <WiFi.h>
#include <WebSocketsClient.h>        // library "WebSockets" by Markus Sattler
#include <I2S.h>                     // ESP32 core 2.0.17 only (core 3.x removed it)
#include <freertos/stream_buffer.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <FluxGarage_RoboEyes.h>
#include "secrets.h"                 // WIFI_SSID, WIFI_PASS, WORKER_HOST, APP_KEY

// ---------------------------------------------------------------- wiring
#define OLED_SDA     14
#define OLED_SCL     13
#define I2S_BCLK_PIN 5
#define I2S_LRC_PIN  6
#define I2S_DOUT_PIN 7
#define AMP_SD_PIN   15     // MAX98357A SD: LOW = amp shut down (silent, no idle hiss), HIGH = on

// ---------------------------------------------------------------- audio tuning
#define AUDIO_RATE   24000  // every reply is 24 kHz 16-bit mono PCM (the Worker resamples to this)
#define VOLUME_PCT   50     // calibration knob: scale PCM before the amp (100 = as sent)
#define PREBUF_MS    250    // audio buffered before playback starts; the smallest value with no
                            // starvation in the RTOS study (bench/REPORT_section.md, P* = 250 ms)
#define SB_BYTES     (1024 * 1024)  // reply buffer in PSRAM: ~21 s of audio, a whole reply fits
#define MOOD_HOLD_MS 3000   // keep the mood face this long after the last word

// ---------------------------------------------------------------- what the face can show
// "State" = what the speaker is doing; the Worker pushes it over the WebSocket.
enum State : uint8_t { OFFLINE, IDLE, LISTENING, THINKING, SPEAKING };
static const char *const NAMES[] = {"offline", "idle", "listening", "thinking", "speaking"};

// "Mood" = Dess's expression while she speaks; same order and names as MOODS in the Worker.
enum Mood : uint8_t { M_NEUTRAL, M_HAPPY, M_TIRED, M_ANGRY, M_CONFUSED, M_LAUGH };
static const char *const MOODS[] = {"neutral", "happy", "tired", "angry", "confused", "laugh"};

// ---------------------------------------------------------------- shared between tasks
// state/mood are written by the network code (loop task) and, after playback, by the audio task.
// Those never overlap in time (the server pushes "thinking" before the audio and nothing during
// it), so a plain volatile is enough: no mutex.
extern volatile uint8_t state;
extern volatile uint8_t mood;
extern TaskHandle_t audioTaskHandle;

// RoboEyes ends every frame with display->display(). Shadowing it lets us draw the state glyph
// on top of the face in the same frame (no flicker, no library patch).
void overlay(Adafruit_GFX &g);
class Oled : public Adafruit_SSD1306 {
 public:
  using Adafruit_SSD1306::Adafruit_SSD1306;
  void display() {
    overlay(*this);
    Adafruit_SSD1306::display();
  }
};
extern Oled display;
extern RoboEyes<Oled> eyes;

// ---------------------------------------------------------------- what each tab offers the others
void faceBegin();                 // face.ino:  init OLED + eyes
void faceTask(void *);            //            FreeRTOS task: draws the face forever (core 0)
void audioBegin();                // audio.ino: init I2S + reply buffer
void audioTask(void *);           //            FreeRTOS task: plays replies (core 1)
void audioStart(long bytes);      //            a reply header arrived
void audioPush(const uint8_t *data, size_t len);  // a binary PCM frame arrived
void audioAbort();                //            socket dropped mid-reply
bool audioBusy();                 //            a reply is being received/played
void netBegin();                  // net.ino:   Wi-Fi + WebSocket
void netLoop();                   //            pump the WebSocket (called from loop())
