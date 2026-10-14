import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;

// Baked in at build time from env.json (gitignored): flutter run --dart-define-from-file=env.json
const workerUrl = String.fromEnvironment('WORKER_URL');
const appKey = String.fromEnvironment('APP_KEY');

class Reply {
  Reply(this.heard, this.text, this.wav, this.ms, this.mood);
  final String heard; // what Whisper heard you say
  final String text; // what the AI answered
  final Uint8List? wav; // the spoken answer; null when the reply was sent to the speaker instead
  final Map<String, int> ms; // per-stage latency: stt, llm, tts, total
  final String mood; // Dess's mood for this reply: neutral happy tired angry confused laugh
}

/// One turn: m4a + recent history in, transcript + reply + WAV + timings out.
Future<Reply> sendTurn(String audioPath, List<Map<String, String>> history, String target, String lang) async {
  if (workerUrl.isEmpty || appKey.isEmpty) {
    throw StateError('No WORKER_URL/APP_KEY: run with --dart-define-from-file=env.json');
  }
  final req = http.MultipartRequest('POST', Uri.parse('$workerUrl/chat'))
    ..headers['X-App-Key'] = appKey
    ..fields['meta'] = jsonEncode({'history': history, 'target': target, 'lang': lang})
    ..files.add(await http.MultipartFile.fromPath('audio', audioPath));

  // covers upload + the whole STT→LLM→TTS pipeline; normal is ~2 s
  final res = await req.send().then(http.Response.fromStream).timeout(const Duration(seconds: 15));
  if (res.statusCode != 200) {
    final body = res.body.length > 200 ? '${res.body.substring(0, 200)}…' : res.body;
    throw Exception('Worker ${res.statusCode}: $body');
  }

  if (target == 'speaker') {
    // the Worker pushes the audio to the ESP32 and answers with JSON instead of a WAV
    final j = jsonDecode(utf8.decode(res.bodyBytes)) as Map<String, dynamic>;
    if (j['delivered'] == 0) throw Exception('Speaker is offline');
    return Reply(j['heard'] as String, j['reply'] as String, null, {
      for (final e in (j['ms'] as Map<String, dynamic>).entries) e.key: e.value as int,
    }, j['mood'] as String? ?? 'happy');
  }

  String text(String h) => Uri.decodeComponent(res.headers[h] ?? ''); // http lowercases header names
  int ms(String h) => int.tryParse(res.headers['x-ms-$h'] ?? '') ?? 0;
  return Reply(
    text('x-heard'),
    text('x-reply'),
    res.bodyBytes,
    {for (final h in ['stt', 'llm', 'tts', 'total']) h: ms(h)},
    res.headers['x-mood'] ?? 'happy',
  );
}

/// Is the Worker reachable, and is the ESP32 connected to it? speaker is null when unknown.
Future<({bool worker, bool? speaker})> checkLink() async {
  if (workerUrl.isEmpty || appKey.isEmpty) return (worker: false, speaker: null);
  for (var attempt = 0; attempt < 2; attempt++) {
    try {
      final r = await http.get(Uri.parse('$workerUrl/status'), headers: {'X-App-Key': appKey}).timeout(const Duration(seconds: 3));
      if (r.statusCode == 200) return (worker: true, speaker: ((jsonDecode(r.body) as Map)['online'] as int) > 0);
      return (worker: r.statusCode == 405, speaker: null); // 405 = an older Worker without /status: it answered, so it's up
    } catch (_) {
      // right after launch the first request can fail while the network wakes up: try once more
      if (attempt == 0) await Future<void>.delayed(const Duration(milliseconds: 800));
    }
  }
  return (worker: false, speaker: null);
}

/// Tells the speaker's face what the phone is doing. Best effort: an offline speaker or network is fine.
Future<void> pushState(String state) async {
  if (workerUrl.isEmpty || appKey.isEmpty) return;
  try {
    await http
        .post(Uri.parse('$workerUrl/state'), headers: {'X-App-Key': appKey}, body: jsonEncode({'state': state}))
        .timeout(const Duration(seconds: 3));
  } catch (_) {}
}
