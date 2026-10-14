// OLED step 1: I2C scanner. Expect "found 0x3C" (some modules are 0x3D).
#include <Arduino.h>
#include <Wire.h>

#define SDA_PIN 14
#define SCL_PIN 13

void setup() {
  Serial.begin(115200);
  delay(1500);  // let USB CDC enumerate so the first prints aren't lost
  Wire.begin(SDA_PIN, SCL_PIN);
  Serial.println("I2C scan on SDA=14 SCL=13");
}

void loop() {
  int n = 0;
  for (uint8_t a = 1; a < 127; a++) {
    Wire.beginTransmission(a);
    if (Wire.endTransmission() == 0) {
      Serial.printf("found 0x%02X\n", a);
      n++;
    }
  }
  if (!n) Serial.println("nothing found - check wiring");
  delay(2000);
}
