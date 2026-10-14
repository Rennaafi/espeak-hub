// OLED step 2: EMO-style eyes. Cycles moods so you can see each expression.
#include <Arduino.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <FluxGarage_RoboEyes.h>

Adafruit_SSD1306 display(128, 64, &Wire, -1);
RoboEyes<Adafruit_SSD1306> eyes(display);

void setup() {
  Serial.begin(115200);
  Wire.begin(14, 13);
  if (!display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {
    Serial.println("SSD1306 init failed");
    for (;;) delay(1000);
  }
  display.ssd1306_command(SSD1306_DISPLAYON);  // same init that worked in oled_hello
  display.dim(false);
  eyes.begin(128, 64, 30);        // max fps
  eyes.setAutoblinker(ON, 3, 2);  // blink every 3 s +- 2
  eyes.setIdleMode(ON, 2, 2);     // look around every 2 s +- 2
}

void loop() {
  eyes.update();  // must run every loop, it paces itself to the fps

  static uint32_t t0 = 0;
  static uint8_t i = 0;
  if (millis() - t0 > 4000) {
    t0 = millis();
    switch (i++ % 4) {
      case 0: eyes.setMood(DEFAULT); Serial.println("default"); break;
      case 1: eyes.setMood(HAPPY);   Serial.println("happy");   break;
      case 2: eyes.setMood(TIRED);   Serial.println("tired");   break;
      case 3: eyes.setMood(ANGRY);   Serial.println("angry");   break;
    }
  }
}
