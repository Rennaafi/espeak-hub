// Step 4a: is the 8 MB PSRAM usable? Allocates 2 MB, writes + reads back a pattern, prints sizes.
#include <Arduino.h>

void setup() {
  Serial.begin(115200);
  delay(1500);
  Serial.printf("psramFound=%d size=%u free=%u heap_free=%u\n", psramFound(), ESP.getPsramSize(), ESP.getFreePsram(), ESP.getFreeHeap());
  const size_t n = 2 * 1024 * 1024;
  uint8_t *p = (uint8_t *)ps_malloc(n);
  if (!p) {
    Serial.println("ps_malloc 2 MB FAILED");
    return;
  }
  for (size_t i = 0; i < n; i++) p[i] = i * 31;
  size_t bad = 0;
  for (size_t i = 0; i < n; i++) bad += p[i] != (uint8_t)(i * 31);
  Serial.printf("2 MB write/read: %u mismatches -> %s\n", (unsigned)bad, bad ? "BAD" : "OK");
  free(p);
}

void loop() {}
