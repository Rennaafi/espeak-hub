// Step 3a: Wi-Fi + face. TIRED eyes while connecting, HAPPY once connected, ANGRY on failure (RoboEyes has no CONFUSED mood).
// Prints IP + RSSI on serial. Credentials live in src/secrets.h (gitignored, see secrets.h.example).
#include <Arduino.h>
#include <Wire.h>
#include <WiFi.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <FluxGarage_RoboEyes.h>
#include "secrets.h"

Adafruit_SSD1306 display(128, 64, &Wire, -1);
RoboEyes<Adafruit_SSD1306> eyes(display);

volatile uint8_t mood = TIRED;  // net (loop) -> face task; one writer, one reader

void faceTask(void *) {
  uint8_t last = 255;
  for (;;) {
    if (mood != last) {
      last = mood;
      eyes.setMood(last);
    }
    eyes.update();
    vTaskDelay(1);
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
  xTaskCreatePinnedToCore(faceTask, "face", 8192, nullptr, 1, nullptr, 0);

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.printf("connecting to \"%s\"", WIFI_SSID);
}

void loop() {
  static uint32_t t0 = millis();
  if (WiFi.status() == WL_CONNECTED) {
    if (mood != HAPPY) {
      mood = HAPPY;
      Serial.printf("\nconnected: ip=%s rssi=%d dBm\n", WiFi.localIP().toString().c_str(), WiFi.RSSI());
    }
  } else if (millis() - t0 > 15000) {
    if (mood != ANGRY) Serial.printf("\nno connection after 15 s (status=%d)\n", WiFi.status());
    mood = ANGRY;  // WiFi keeps retrying on its own; the face flips back to HAPPY if it succeeds
  } else {
    Serial.print('.');
  }
  delay(500);
}
