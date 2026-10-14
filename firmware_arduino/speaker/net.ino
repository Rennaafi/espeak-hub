// net.ino - Wi-Fi + the WebSocket to the Worker's Durable Object (path /ws).
//
// The server sends two kinds of message on this one socket:
//   text    {"state":"thinking"}                       -> change the face
//           {"type":"audio","rate":24000,"bytes":N,"mood":"happy"}   -> a reply is coming
//   binary  raw 16-bit mono PCM, in 8 KB frames, right after the audio header
// This tab only parses and routes them; face.ino and audio.ino do the actual work.
#include "shared.h"

WebSocketsClient ws;

// ponytail: substring parsing of our own fixed-shape messages; use ArduinoJson once they get richer
long field(const char *msg, const char *key) {  // number after e.g. "\"bytes\":", or -1
  const char *p = strstr(msg, key);
  return p ? atol(p + strlen(key)) : -1;
}

// sets `mood` from a "mood":"x" field; false if the message has none
bool readMood(const char *msg) {
  const char *m = strstr(msg, "\"mood\":\"");
  for (uint8_t i = 0; m && i < sizeof MOODS / sizeof *MOODS; i++)
    if (!strncmp(m + 8, MOODS[i], strlen(MOODS[i]))) { mood = i; return true; }
  return false;
}

void onEvent(WStype_t type, uint8_t *payload, size_t len) {
  if (type == WStype_CONNECTED) {
    Serial.println("ws: connected");
    state = IDLE;
  } else if (type == WStype_DISCONNECTED) {
    Serial.println("ws: disconnected");
    audioAbort();            // drop a half-received reply
    state = OFFLINE;         // the library reconnects by itself (see netBegin)
  } else if (type == WStype_TEXT) {
    Serial.printf("ws: %.*s\n", (int)len, payload);
    const char *msg = (const char *)payload;

    if (strstr(msg, "\"type\":\"audio\"")) {      // header of a spoken reply
      long rate = field(msg, "\"rate\":"), bytes = field(msg, "\"bytes\":");
      if (audioBusy() || rate != AUDIO_RATE || bytes <= 0) {
        Serial.printf("audio: ignored (busy=%d rate=%ld bytes=%ld)\n", audioBusy(), rate, bytes);
        return;
      }
      if (!readMood(msg)) mood = M_HAPPY;         // fallback, same as the Worker's
      audioStart(bytes);                          // audio task starts waiting for the prebuffer
      return;
    }

    readMood(msg);                                // POST /state may carry a mood too (used to test faces)
    for (uint8_t s = IDLE; s <= SPEAKING; s++) {  // {"state":"thinking"} etc.
      char want[32];
      snprintf(want, sizeof want, "\"state\":\"%s\"", NAMES[s]);
      if (strstr(msg, want)) state = s;
    }
  } else if (type == WStype_BIN) {
    audioPush(payload, len);                      // a frame of PCM for the reply in progress
  }
}

void netBegin() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.printf("wifi: connecting to \"%s\"\n", WIFI_SSID);
  while (WiFi.status() != WL_CONNECTED) delay(250);
  Serial.printf("wifi: ip=%s rssi=%d dBm psram_free=%u\n", WiFi.localIP().toString().c_str(), WiFi.RSSI(), ESP.getFreePsram());

  // ponytail: beginSSL without a CA/fingerprint does not verify the server cert (the key is still
  // encrypted on the wire); pin Cloudflare's root CA if this ever leaves a trusted hotspot.
  ws.setExtraHeaders("X-App-Key: " APP_KEY);      // the Worker rejects sockets without the shared key
  ws.beginSSL(WORKER_HOST, 443, "/ws");
  ws.onEvent(onEvent);
  ws.setReconnectInterval(3000);
  ws.enableHeartbeat(15000, 3000, 2);             // ping every 15 s, drop + reconnect after 2 missed pongs
}

void netLoop() { ws.loop(); }
