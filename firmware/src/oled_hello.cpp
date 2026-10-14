// OLED step 1.5: no eyes library. Text + border, then flips normal/inverted every second.
// If the panel stays black even when inverted, the panel/power/init is the problem, not RoboEyes.
#include <Arduino.h>
#include <Wire.h>
#include <Adafruit_SSD1306.h>

Adafruit_SSD1306 display(128, 64, &Wire, -1);

void setup() {
  Serial.begin(115200);
  Wire.begin(14, 13);
  bool ok = display.begin(SSD1306_SWITCHCAPVCC, 0x3C);
  Serial.printf("begin=%d\n", ok);
  display.ssd1306_command(SSD1306_DISPLAYON);  // wake the panel in case it booted in sleep
  display.dim(false);                          // full contrast
  display.clearDisplay();
  display.drawRect(0, 0, 128, 64, SSD1306_WHITE);
  display.setTextSize(2);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(10, 24);
  display.print("HELLO");
  display.display();
}

void loop() {
  static bool inv = false;
  display.invertDisplay(inv = !inv);
  Serial.println(inv ? "inverted" : "normal");
  delay(1000);
}
