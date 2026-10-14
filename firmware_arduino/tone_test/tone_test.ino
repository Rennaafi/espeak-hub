// ESPeak Hub - Arduino IDE sketch: 444 Hz I2S test tone on a MAX98357A amp.
// Same code as firmware/src/main.cpp (PlatformIO), so both toolchains stay in sync.
//
// REQUIRES the ESP32 core 2.0.17 (Boards Manager: "esp32 by Espressif Systems" -> 2.0.17).
// Core 3.x removed <I2S.h> in favour of <ESP_I2S.h>, so this sketch won't compile there.
// See firmware_arduino/README.md for the exact Tools-menu settings.
//
// Wiring (MAX98357A -> ESP32-S3), CHANGE the pins below if your board differs:
//   BCLK -> GPIO 5
//   LRC  -> GPIO 6
//   DIN  -> GPIO 7
//   GAIN, SD -> leave floating
//   VIN  -> 5V, GND -> GND

#include <I2S.h>

#define I2S_BCLK_PIN 5
#define I2S_LRC_PIN  6
#define I2S_DOUT_PIN 7

const int frequency = 440;   // A4, Hz
const int amplitude = 6000;  // headroom below INT16_MAX (32767); lower it if too loud
const int sampleRate = 8000;
const int bitsPerSample = 16;

// samples per HALF period (the sign flips twice per cycle): 8000 / 880 = 9 -> ~444 Hz
const int halfWavelength = sampleRate / (2 * frequency);

short sample = amplitude;
int count = 0;

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("ESPeak Hub - I2S test tone");

  I2S.setAllPins(I2S_BCLK_PIN, I2S_LRC_PIN, I2S_DOUT_PIN, I2S_DOUT_PIN, I2S_DOUT_PIN);

  if (!I2S.begin(I2S_PHILIPS_MODE, sampleRate, bitsPerSample)) {
    Serial.println("Failed to start I2S - check wiring/pins above");
    while (true) {
      delay(1000);
    }
  }

  // prints the frequency actually produced, so the Serial Monitor proves the math
  Serial.printf("I2S started, playing %d Hz test tone...\n", sampleRate / (2 * halfWavelength));
}

void loop() {
  if (count % halfWavelength == 0) {
    sample = -sample;  // invert every half wavelength to build a square wave
  }

  I2S.write(sample);  // right channel
  I2S.write(sample);  // left channel (MAX98357A sums L+R to mono output)

  count++;
}
