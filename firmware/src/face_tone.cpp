// Step 2b: tone (core 1, prio 3) + RoboEyes face (core 0, prio 1) as two FreeRTOS tasks.
// Tone plays 5 s with happy eyes, then 3 s silence with default eyes. If the tone ever
// crackles/stutters while the face animates, the face task is starving the audio task.
#include <Arduino.h>
#include <Wire.h>
#include <I2S.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <FluxGarage_RoboEyes.h>

#define I2S_BCLK_PIN 5
#define I2S_LRC_PIN  6
#define I2S_DOUT_PIN 7

const int sampleRate = 8000;
const int amplitude = 6000;
const int halfWavelength = sampleRate / (2 * 440);  // 444 Hz square wave

volatile bool speaking = false;  // audio task -> face task (one writer, one reader)

Adafruit_SSD1306 display(128, 64, &Wire, -1);
RoboEyes<Adafruit_SSD1306> eyes(display);

void audioTask(void *) {
  short sample = amplitude;
  int count = 0;
  uint32_t t0 = millis();
  for (;;) {
    uint32_t t = (millis() - t0) % 8000;
    speaking = t < 5000;  // 5 s on, 3 s off
    if (count % halfWavelength == 0) sample = -sample;
    short out = speaking ? sample : 0;  // keep clocks running in silence
    I2S.write(out);  // blocks when the DMA buffer is full, so this task mostly sleeps
    I2S.write(out);
    count++;
  }
}

void faceTask(void *) {
  bool last = false;
  for (;;) {
    if (speaking != last) {
      last = speaking;
      eyes.setMood(last ? HAPPY : DEFAULT);
      Serial.println(last ? "speaking" : "idle");
    }
    eyes.update();
    vTaskDelay(1);  // yield; update() paces itself to the fps
  }
}

void setup() {
  Serial.begin(115200);
  Wire.begin(14, 13);
  if (!display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {
    Serial.println("SSD1306 init failed");
    for (;;) delay(1000);
  }
  display.ssd1306_command(SSD1306_DISPLAYON);
  display.dim(false);
  eyes.begin(128, 64, 30);
  eyes.setAutoblinker(ON, 3, 2);
  eyes.setIdleMode(ON, 2, 2);

  I2S.setAllPins(I2S_BCLK_PIN, I2S_LRC_PIN, I2S_DOUT_PIN, I2S_DOUT_PIN, I2S_DOUT_PIN);
  if (!I2S.begin(I2S_PHILIPS_MODE, sampleRate, 16)) {
    Serial.println("Failed to start I2S");
    for (;;) delay(1000);
  }

  xTaskCreatePinnedToCore(audioTask, "audio", 4096, nullptr, 3, nullptr, 1);
  xTaskCreatePinnedToCore(faceTask, "face", 8192, nullptr, 1, nullptr, 0);
  vTaskDelete(nullptr);  // Arduino's loopTask has nothing left to do
}

void loop() {}
