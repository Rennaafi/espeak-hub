// AI Voice Speaker - Step 1: play a test tone over I2S on a MAX98357A amp.
// No Wi-Fi/MQTT yet - that comes in step 2 once this is confirmed working.
//
// Adapted from the official Arduino-ESP32 I2S "SimpleTone" example
// (framework-arduinoespressif32/libraries/I2S/examples/SimpleTone).
//
// Wiring (MAX98357A -> ESP32-S3), adjust the pins below to match your build:
//   BCLK -> GPIO 5
//   LRC  -> GPIO 6
//   DIN  -> GPIO 7
//   GAIN -> leave floating (default gain) or tie per datasheet
//   SD   -> leave floating (module enables itself when it sees a clock)
//   VIN  -> 5V, GND -> GND

#include <Arduino.h>
#include <I2S.h>

#define I2S_BCLK_PIN 5
#define I2S_LRC_PIN  6
#define I2S_DOUT_PIN 7
#define AMP_SD_PIN   15

const int frequency = 440;    // A4, Hz
const int amplitude = 6000;   // headroom below INT16_MAX (32767)
const int sampleRate = 8000;
const int bitsPerSample = 16;

// samples per HALF period: the sign flips twice per cycle. (The upstream SimpleTone example
// uses sampleRate / frequency here, which is a full period -> plays an octave low, ~222 Hz.)
// Integer division: 8000 / 880 = 9 -> 8000 / 18 = 444 Hz, close enough for a test tone.
const int halfWavelength = sampleRate / (2 * frequency);

short sample = amplitude;
int count = 0;

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("AI Speaker - I2S test tone (step 1)");

  pinMode(AMP_SD_PIN, OUTPUT);
  digitalWrite(AMP_SD_PIN, HIGH);  // SD is wired to GPIO15 now: HIGH = amp on (speaker.cpp mutes it between replies)

  I2S.setAllPins(I2S_BCLK_PIN, I2S_LRC_PIN, I2S_DOUT_PIN, I2S_DOUT_PIN, I2S_DOUT_PIN);

  if (!I2S.begin(I2S_PHILIPS_MODE, sampleRate, bitsPerSample)) {
    Serial.println("Failed to start I2S - check wiring/pins above");
    while (true) {
      delay(1000);
    }
  }

  // print the frequency actually produced, so the serial monitor proves the math
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
