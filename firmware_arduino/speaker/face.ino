// face.ino - the OLED face (Dess): eyes, a state glyph, idle "vibes", sleep. Runs as its own task on core 0.
//
// The face mirrors `state` (written by net.ino / audio.ino) so the speaker is readable at a glance:
//   offline   tired eyes + Wi-Fi arcs         idle      neutral eyes, blinking, wandering; after 3 s short "vibes"
//   listening wide eyes + mic glyph           thinking  eyes look up-right + hopping dots
//   speaking  the reply's mood (happy/angry/tired/confused/laugh) + speaker glyph
// After 2 min idle the eyes close and the panel dims ("zzz"); after 10 min the panel turns off
// (burn-in, power). Any event wakes it. Eyes come from the RoboEyes library; the glyph, label and
// vibes are drawn by us on the same SSD1306 frame buffer.
#include "shared.h"

#define FRAME_MS      33     // task period: ~30 fps
#define FRAME_GATE_MS 30     // RoboEyes/vibes frame gate, just under the period so every wake draws

Oled display(128, 64, &Wire, -1);
RoboEyes<Oled> eyes(display);

#define VIBE_AFTER_MS 3000    // idle this long before the first vibe
#define VIBE_MS       7000    // one vibe lasts this long, then the plain face rests
#define SLEEP_MS      120000  // idle this long: eyes shut + dim (same as the app's Dess)
#define PANEL_OFF_MS  600000  // ...and this long: panel off
static volatile bool asleep = false;
static volatile uint32_t labelUntil = 0;
static const char *volatile labelText = nullptr;

void faceBegin() {
  Wire.begin(OLED_SDA, OLED_SCL);
  if (!display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {
    Serial.println("SSD1306 init failed");
    for (;;) delay(1000);
  }
  display.ssd1306_command(SSD1306_DISPLAYON);
  display.dim(false);
  eyes.begin(128, 64, 1000 / FRAME_GATE_MS);
  eyes.setAutoblinker(OFF);  // faceTask turns it on after the power-on wake-up
}

// Map a state to RoboEyes settings. RoboEyes has 4 moods; confused/laugh are one-shot shake
// animations, triggered in faceTask while speaking.
static void apply(uint8_t s) {
  uint8_t m = s == OFFLINE ? M_TIRED : s == SPEAKING ? mood : M_NEUTRAL;
  eyes.setMood(m == M_HAPPY || m == M_LAUGH ? HAPPY : m == M_TIRED ? TIRED : m == M_ANGRY ? ANGRY : DEFAULT);
  eyes.setPosition(s == THINKING ? NE : DEFAULT);
  eyes.setHeight(s == LISTENING ? 48 : 36, s == LISTENING ? 48 : 36);  // wide eyes = "I'm listening"
  eyes.setIdleMode(s == IDLE || s == SPEAKING || s == OFFLINE, 2, 2);
}

// ---- state glyph (top-left 14x14 on a black backing) + its name along the bottom for a moment ----
void overlay(Adafruit_GFX &g) {
  uint32_t now = millis();
  uint8_t s = state;
  g.setTextSize(1);
  g.setTextColor(WHITE);
  if (asleep) {
    for (int i = 0; i < 3; i++) {  // floating z z z
      uint32_t ph = (now / 30 + i * 33) % 100;
      g.setTextSize(ph > 50 ? 2 : 1);
      g.setCursor(84 + ph / 5, 44 - ph / 3);
      g.print('z');
    }
    return;
  }
  if (s != IDLE) {
    g.fillRect(0, 0, 14, 14, BLACK);
    if (s == LISTENING) {  // mic
      g.fillRoundRect(5, 0, 4, 8, 2, WHITE);
      g.drawCircleHelper(7, 5, 5, 0xC, WHITE);
      g.drawFastVLine(7, 10, 3, WHITE);
      g.drawFastHLine(4, 13, 7, WHITE);
    } else if (s == THINKING) {  // three dots, one hops
      for (int i = 0; i < 3; i++) g.fillCircle(2 + i * 5, 8 - (now / 250 % 3 == (uint32_t)i ? 3 : 0), 1, WHITE);
    } else if (s == SPEAKING) {  // speaker + waves
      g.fillRect(0, 5, 3, 5, WHITE);
      g.fillTriangle(3, 7, 7, 2, 7, 13, WHITE);
      g.drawCircleHelper(8, 7, 3, 0x6, WHITE);
      if (now / 300 % 2) g.drawCircleHelper(8, 7, 6, 0x6, WHITE);
    } else {  // OFFLINE: Wi-Fi arcs sweep while connecting; steady + a cross once Wi-Fi is up but the cloud isn't
      bool wifi = WiFi.status() == WL_CONNECTED;
      int shown = wifi ? 3 : (int)(now / 300 % 4);
      for (int i = 0; i < shown; i++) g.drawCircleHelper(7, 13, 3 + i * 3, 0x3, WHITE);
      g.fillCircle(7, 13, 1, WHITE);
      if (wifi) {
        g.drawLine(9, 8, 13, 12, WHITE);
        g.drawLine(13, 8, 9, 12, WHITE);
      }
    }
  }
  if (now < labelUntil && labelText) {
    g.fillRect(0, 55, 128, 9, BLACK);
    g.setCursor((128 - 6 * strlen(labelText)) / 2, 56);
    g.print(labelText);
  }
}

// ---- idle vibes: drawn straight on the panel while RoboEyes is paused ----
static void eyePair(int dx, int dy, int w, int h, bool happy) {
  int x = (128 - (2 * w + 10)) / 2 + dx, y = (64 - h) / 2 + dy;
  for (int i = 0; i < 2; i++) {
    int ex = x + i * (w + 10);
    display.fillRoundRect(ex, y, w, h, 8, WHITE);
    if (happy) display.fillRoundRect(ex - 3, y + h * 55 / 100, w + 6, h, 10, BLACK);  // lower lid up = ^ ^ squint
  }
}

static void sparkle(int x, int y, int r) {
  display.drawFastHLine(x - r, y, 2 * r + 1, WHITE);
  display.drawFastVLine(x, y - r, 2 * r + 1, WHITE);
}

#define NVIBES 4
static void vibeFrame(int id, uint32_t t) {
  display.clearDisplay();
  float ft = t;
  if (id == 0) {  // bouncing to a beat, notes float up the sides
    eyePair(0, 2 - (int)(fabsf(sinf(PI * ft / 500)) * 7), 36, 32, true);
    const int xs[3] = {8, 112, 121};
    for (int i = 0; i < 3; i++) {
      int x = xs[i] + (int)(sinf(ft / 200 + i) * 3), y = 62 - (int)((t / 18 + i * 37) % 64);
      display.fillCircle(x, y, 2, WHITE);
      display.drawFastVLine(x + 2, y - 7, 7, WHITE);
      display.drawLine(x + 2, y - 7, x + 5, y - 5, WHITE);
    }
  } else if (id == 1) {  // equalizer along the bottom
    eyePair(0, -14, 36, 28, false);
    for (int i = 0; i < 16; i++) {
      int h = 3 + (int)((sinf(ft / 90 + i * 0.8f) + sinf(ft / 137 + i * 1.7f) + 2) * 4.5f);
      display.fillRect(4 + i * 8, 63 - h, 6, h, WHITE);
    }
  } else if (id == 2) {  // sunglasses slide in, hold, slide out
    float k = t < 700 ? ft / 700 : (t > VIBE_MS - 700 ? (VIBE_MS - ft) / 700 : 1);
    k = 1 - (1 - k) * (1 - k);
    int y = 19 - (int)((1 - k) * 46);
    eyePair(0, 0, 36, 26, false);
    for (int i = 0; i < 2; i++) {
      int x = 19 + i * 46;
      display.fillRoundRect(x, y, 44, 26, 9, WHITE);
      display.drawLine(x + 10, y + 22, x + 22, y + 4, BLACK);
      display.drawLine(x + 15, y + 22, x + 27, y + 4, BLACK);
    }
    display.drawLine(19, y + 6, 0, y + 2, WHITE);
    display.drawLine(109, y + 6, 127, y + 2, WHITE);
  } else {  // happy sway with twinkles
    eyePair((int)(sinf(ft / 380) * 16), (int)(sinf(ft / 190) * 2), 36, 34, true);
    const int px[5] = {14, 112, 20, 108, 64}, py[5] = {10, 14, 54, 50, 5};
    for (int i = 0; i < 5; i++) sparkle(px[i], py[i], 1 + (int)((sinf(ft / 140 + i * 1.3f) + 1) * 2.5f));
  }
  display.display();
}

static void wake() {
  asleep = false;
  display.ssd1306_command(SSD1306_DISPLAYON);
  display.dim(false);
  eyes.setAutoblinker(ON, 3, 2);
  eyes.open();
}

// the task body: one pass = react to a state change, run sleep/vibe timers, draw one frame
void faceTask(void *) {
  uint8_t last = 255;
  uint32_t nextShake = 0, idleSince = millis(), nextVibe = 0, vibeAt = 0, lastFrame = 0, bootAt = millis();
  bool panelOff = false, woke = false;
  int vibe = -1, lastVibe = -1;
  // vTaskDelayUntil = a fixed 33 ms period, not "poll every tick": the task sleeps between frames
  TickType_t wakeAt = xTaskGetTickCount();
#define FACE_WAIT() vTaskDelayUntil(&wakeAt, pdMS_TO_TICKS(FRAME_MS))
  for (;;) {
    uint32_t now = millis();
    if (state != last) {
      bool first = last == 255;
      last = state;
      apply(last);
      if (first) eyes.close();  // power-on: a thin line, opened below
      else if (asleep) {
        wake();
        panelOff = false;
      }
      idleSince = now;
      nextVibe = now + VIBE_AFTER_MS;
      vibe = -1;
      nextShake = 0;
      if (last != IDLE) {  // flash the state's name for a moment
        labelText = last == OFFLINE ? (WiFi.status() == WL_CONNECTED ? "OFFLINE" : "CONNECTING") : last == LISTENING ? "LISTENING" : last == THINKING ? "THINKING" : "SPEAKING";
        labelUntil = now + 1500;
      }
      if (last == SPEAKING) Serial.printf("face: speaking / %s\n", MOODS[mood]);
      else Serial.printf("face: %s\n", NAMES[last]);
    }
    if (!woke && now - bootAt > 700) {  // eyes open after a beat
      woke = true;
      eyes.open();
      eyes.setAutoblinker(ON, 3, 2);
    }
    if (last == IDLE && woke) {
      uint32_t idle = now - idleSince;
      if (!asleep && idle > SLEEP_MS) {  // eyes shut, dim, z z z
        asleep = true;
        vibe = -1;
        eyes.setAutoblinker(OFF);
        eyes.setIdleMode(OFF);
        eyes.close();
        display.dim(true);
      }
      if (asleep && !panelOff && idle > PANEL_OFF_MS) {
        panelOff = true;
        display.ssd1306_command(SSD1306_DISPLAYOFF);
      }
      if (!asleep) {
        if (vibe < 0 && now >= nextVibe) {
          do vibe = random(NVIBES); while (vibe == lastVibe);
          lastVibe = vibe;
          vibeAt = now;
        }
        if (vibe >= 0) {
          if (now - vibeAt > VIBE_MS) {
            vibe = -1;
            nextVibe = now + random(10000, 25000);
          } else {
            if (now - lastFrame >= FRAME_GATE_MS) {
              lastFrame = now;
              vibeFrame(vibe, now - vibeAt);
            }
            FACE_WAIT();
            continue;
          }
        }
      }
    }
    // confused/laugh are one-shot shakes (~0.5 s), so repeat them while the reply plays
    if (last == SPEAKING && (mood == M_CONFUSED || mood == M_LAUGH) && now >= nextShake) {
      mood == M_CONFUSED ? eyes.anim_confused() : eyes.anim_laugh();
      nextShake = now + 1500;
    }
    if (!panelOff) eyes.update();
    FACE_WAIT();
  }
}
