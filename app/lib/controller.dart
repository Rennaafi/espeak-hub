import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:just_audio/just_audio.dart';
import 'package:path_provider/path_provider.dart';
import 'package:record/record.dart';
import 'package:share_plus/share_plus.dart';

import 'api.dart';
import 'db.dart';

// Same states the ESP32 OLED will show.
enum Phase { idle, listening, thinking, speaking, error }

const _contextTurns = 6; // how many past turns the AI remembers

class AppController extends ChangeNotifier {
  final _rec = AudioRecorder();
  final _player = AudioPlayer();

  String target = 'phone'; // 'phone' plays the reply here, 'speaker' sends it to the ESP32
  String lang = 'en'; // 'en' English, 'buddy' English + Korean phrases, 'ko' full Korean (Worker meta.lang)
  // ponytail: target and lang are not saved, so the app restarts on 'phone'/'en'; persist them if that gets annoying
  Phase phase = Phase.idle;
  String? hint; // one-line message under the mic button
  List<Turn> turns = []; // the open chat's turns, oldest first
  int chatId = DateTime.now().millisecondsSinceEpoch; // the open chat
  bool showLatency = false; // latency numbers under each reply (⚙ switch, saved in the db)
  bool _opened = false; // true once the user opened an old chat on purpose: it never auto-splits
  bool _pressed = false;
  DateTime? _startedAt;
  String mood = 'neutral'; // Dess's mood for the current/last reply
  bool _moodHeld = false; // keep the mood face for a moment after the reply ends
  Timer? _moodTimer;
  bool? workerUp; // null = still checking
  bool? speakerUp; // null = unknown (older Worker, or the cloud itself is down)
  bool _checking = false;
  Timer? _linkTimer;

  /// Asks the Worker if it's reachable and if the ESP32 is connected. [quiet] keeps the icon steady on timed checks.
  Future<void> refreshLink({bool quiet = true}) async {
    if (_checking) return;
    _checking = true;
    if (!quiet) {
      workerUp = null;
      notifyListeners();
    }
    final r = await checkLink();
    _checking = false;
    if (r.worker == workerUp && r.speaker == speakerUp) return;
    workerUp = r.worker;
    speakerUp = r.speaker;
    notifyListeners();
  }

  AppController() {
    refreshLink();
    _linkTimer = Timer.periodic(const Duration(seconds: 15), (_) => refreshLink());
    _player.playerStateStream.listen((s) {
      if (s.processingState == ProcessingState.completed && phase == Phase.speaking) {
        _set(Phase.idle);
        _hold(const Duration(seconds: 3));
      }
    });
    getSetting('showLatency').then((v) {
      showLatency = v == '1';
      notifyListeners();
    });
    allTurns().then((all) async {
      // resume the last chat if it's recent, else start fresh
      if (all.isNotEmpty && DateTime.now().difference(all.last.ts) < chatGap) {
        chatId = all.last.chatId;
        turns = await turnsOfChat(chatId);
      }
      notifyListeners();
    });
  }

  /// What the face shows: the reply's mood while speaking and for a moment after, else calm.
  String get faceMood => phase == Phase.speaking || _moodHeld ? mood : (phase == Phase.error ? 'confused' : 'neutral');

  void _hold(Duration d) {
    _moodHeld = true;
    _moodTimer?.cancel();
    _moodTimer = Timer(d, () {
      _moodHeld = false;
      notifyListeners();
    });
    notifyListeners();
  }

  void _set(Phase p, [String? h]) {
    if (p == Phase.listening || p == Phase.thinking) _moodHeld = false;
    phase = p;
    hint = h;
    notifyListeners();
  }

  void setLang(String l) {
    lang = l;
    notifyListeners();
  }

  void setTarget(String t) {
    target = t;
    notifyListeners();
    if (t == 'speaker') refreshLink(); // is it actually there?
  }

  Future<void> pressDown() async {
    _pressed = true;
    await _player.stop(); // barge-in: talking over a reply cuts it off
    if (!await _rec.hasPermission()) {
      _set(Phase.error, 'Microphone blocked: enable it in Android Settings → Apps → espeak_hub');
      return;
    }
    final dir = await getTemporaryDirectory();
    final path = '${dir.path}/turn_${DateTime.now().millisecondsSinceEpoch}.m4a';
    // AAC 16 kHz mono: ~10x smaller than WAV, and Whisper accepts m4a
    await _rec.start(const RecordConfig(encoder: AudioEncoder.aacLc, sampleRate: 16000, numChannels: 1), path: path);
    if (!_pressed) {
      await _rec.cancel(); // finger lifted while we were starting (e.g. during the permission dialog)
      return;
    }
    _startedAt = DateTime.now();
    _set(Phase.listening);
    if (target == 'speaker') pushState('listening').ignore();
  }

  Future<void> release() async {
    _pressed = false;
    if (phase != Phase.listening) return;
    final held = DateTime.now().difference(_startedAt!);
    final path = await _rec.stop();
    if (path == null || held < const Duration(milliseconds: 500)) {
      if (path != null) File(path).delete().ignore();
      _set(Phase.idle, 'Hold longer'); // a tap sends silence and Whisper invents text
      if (target == 'speaker') pushState('idle').ignore(); // take the speaker's face off "listening"
      return;
    }
    await _send(path);
  }

  /// Resend a failed turn's kept recording.
  Future<void> retry(Turn failed) async {
    if (phase == Phase.listening || phase == Phase.thinking) return;
    if (failed.audioPath == null || !File(failed.audioPath!).existsSync()) {
      _set(Phase.idle, 'That recording is gone, please ask again');
      return;
    }
    await _player.stop();
    await _send(failed.audioPath!, retrying: failed);
  }

  Future<void> _send(String path, {Turn? retrying}) async {
    _set(Phase.thinking);
    if (retrying == null && !_opened && turns.isNotEmpty && DateTime.now().difference(turns.last.ts) > chatGap) {
      newChat(); // the live chat sat idle too long: start a fresh one (and a fresh memory)
    }
    Turn t;
    try {
      final r = await sendTurn(path, _history(), target, lang);
      String? wavPath; // stays null for speaker turns: the audio lives on the ESP32, nothing to replay
      if (r.wav != null) {
        // documents dir (not temp) so replies survive for ▶ replay
        final dir = Directory('${(await getApplicationDocumentsDirectory()).path}/replies');
        await dir.create(recursive: true);
        final wav = File('${dir.path}/${DateTime.now().millisecondsSinceEpoch}.wav');
        await wav.writeAsBytes(r.wav!);
        wavPath = wav.path;
      }
      File(path).delete().ignore(); // success: recording no longer needed
      t = Turn(
        id: retrying?.id,
        ts: DateTime.now(),
        chatId: retrying?.chatId ?? chatId,
        heard: r.heard,
        segments: [
          {'lang': 'en', 'text': r.text},
        ],
        wavPath: wavPath,
        ms: r.ms,
        mood: r.mood,
      );
    } catch (e) {
      refreshLink().ignore(); // a failed turn is the best moment to re-check what's down
      if (target == 'speaker') pushState('idle').ignore(); // the Worker may never have seen this turn
      // keep the recording so "tap to retry" can resend it without talking again
      t = Turn(id: retrying?.id, ts: DateTime.now(), chatId: retrying?.chatId ?? chatId, heard: '', segments: const [], audioPath: path, error: _short(e));
    }

    if (t.id == null) {
      t = Turn.fromRow({...t.toRow(), 'id': await insertTurn(t)});
    } else {
      await updateTurn(t);
    }
    turns
      ..removeWhere((x) => x.id == t.id)
      ..add(t);

    if (t.error != null) {
      _set(Phase.idle); // the red bubble in the timeline explains it; Phase.error is for a blocked mic
      mood = 'confused';
      _hold(const Duration(seconds: 3));
    } else if (t.wavPath != null) {
      mood = t.mood ?? 'happy';
      await _play(t.wavPath!);
    } else {
      mood = t.mood ?? 'happy';
      _set(Phase.idle, 'Playing on the speaker');
      _hold(const Duration(seconds: 4)); // can't hear when the speaker ends, so a fixed moment
    }
  }

  static String _short(Object e) {
    if (e is TimeoutException) return 'timed out after 15 s';
    if (e is SocketException || e is http.ClientException) return 'no connection';
    final s = e.toString();
    return s.length > 120 ? '${s.substring(0, 120)}…' : s;
  }

  /// The open chat's last few turns as chat messages, so the AI can follow up.
  List<Map<String, String>> _history() {
    final ctx = turns.where((t) => t.error == null).toList();
    if (ctx.length > _contextTurns) ctx.removeRange(0, ctx.length - _contextTurns);
    return [
      for (final t in ctx) ...[
        {'role': 'user', 'content': t.heard},
        {'role': 'assistant', 'content': t.replyText},
      ],
    ];
  }

  Future<void> replay(Turn t) async {
    if (t.wavPath == null || !File(t.wavPath!).existsSync()) {
      _set(Phase.idle, 'Audio for that reply is gone');
      return;
    }
    await _player.stop();
    mood = t.mood ?? 'happy';
    await _play(t.wavPath!);
  }

  /// Writes the CSV where `adb pull` / Android Studio's Device Explorer can reach it, then opens the share sheet.
  Future<String> exportLog() async {
    final dir = await getExternalStorageDirectory(); // /sdcard/Android/data/com.refansa.espeak_hub/files
    final file = File('${dir!.path}/latency.csv');
    await file.writeAsString('﻿${await turnsCsv()}'); // BOM: tells Excel it's UTF-8 (else ¥ shows as Â¥)
    SharePlus.instance.share(ShareParams(files: [XFile(file.path)], subject: 'ESPeak Hub latency log')).ignore();
    return file.path;
  }

  void setShowLatency(bool on) {
    showLatency = on;
    setSetting('showLatency', on ? '1' : '0').ignore();
    notifyListeners();
  }

  Future<List<ChatSummary>> chatsList() => chatSummaries();

  Future<void> openChat(int id) async {
    await _player.stop();
    chatId = id;
    turns = await turnsOfChat(id);
    _opened = true; // you chose this chat on purpose, so it never auto-splits
    _set(Phase.idle);
  }

  /// Removes a chat's rows now; its audio files stay until [discardFiles] so Undo can bring it back.
  Future<List<Turn>> deleteChat(int id) async {
    final gone = await turnsOfChat(id);
    await deleteChatRows(id);
    if (id == chatId) newChat();
    return gone;
  }

  Future<void> restoreChat(List<Turn> ts) async {
    await restoreTurns(ts);
    notifyListeners();
  }

  static void discardFiles(List<Turn> ts) {
    for (final t in ts) {
      for (final f in [t.wavPath, t.audioPath]) {
        if (f != null) File(f).delete().ignore();
      }
    }
  }

  /// Starts an empty chat; the old one stays in history.
  void newChat() {
    _player.stop();
    chatId = DateTime.now().millisecondsSinceEpoch;
    turns = [];
    _opened = false;
    _set(Phase.idle);
  }

  Future<void> clearHistory() async {
    await _player.stop();
    discardFiles(await allTurns());
    await clearTurns();
    newChat();
  }

  Future<void> _play(String path) async {
    try {
      _set(Phase.speaking);
      await _player.setFilePath(path);
      _player.play(); // not awaited: playerStateStream flips us back to idle when done
    } catch (e) {
      _set(Phase.error, 'Playback failed: $e');
    }
  }

  @override
  void dispose() {
    _moodTimer?.cancel();
    _linkTimer?.cancel();
    _rec.dispose();
    _player.dispose();
    super.dispose();
  }
}
