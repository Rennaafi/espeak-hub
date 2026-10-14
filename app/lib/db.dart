import 'dart:convert';

import 'package:sqflite/sqflite.dart';

/// A pause longer than this starts a new chat (and Dess forgets what came before).
const chatGap = Duration(minutes: 30);

/// One question + answer. Also one row of the latency log.
class Turn {
  Turn({
    this.id,
    required this.ts,
    required this.heard,
    required this.segments,
    required this.chatId,
    this.wavPath,
    this.audioPath,
    this.ms = const {},
    this.error,
    this.mood,
  });

  final int? id;
  final DateTime ts;
  final int chatId; // = ms timestamp of the chat's first moment; turns with the same id are one chat
  final String heard; // what you said
  final List<Map<String, dynamic>> segments; // reply as [{lang, text}], ready for Korean later
  final String? wavPath; // saved reply audio, for ▶ replay
  final String? audioPath; // your recording, kept only for failed turns (step 6 retry)
  final Map<String, int> ms; // stt, llm, tts, total
  final String? error;
  final String? mood; // Dess's mood for this reply, null on old rows

  String get replyText => segments.map((s) => s['text']).join(' ');

  Map<String, Object?> toRow() => {
        'ts': ts.millisecondsSinceEpoch,
        'chat_id': chatId,
        'heard': heard,
        'segments_json': jsonEncode(segments),
        'wav_path': wavPath,
        'audio_path': audioPath,
        for (final k in ['stt', 'llm', 'tts', 'total']) 'ms_$k': ms[k],
        'error': error,
        'mood': mood,
      };

  static Turn fromRow(Map<String, Object?> r) => Turn(
        id: r['id'] as int,
        ts: DateTime.fromMillisecondsSinceEpoch(r['ts'] as int),
        chatId: r['chat_id'] as int,
        heard: r['heard'] as String,
        segments: (jsonDecode(r['segments_json'] as String) as List).cast<Map<String, dynamic>>(),
        wavPath: r['wav_path'] as String?,
        audioPath: r['audio_path'] as String?,
        ms: {
          for (final k in ['stt', 'llm', 'tts', 'total'])
            if (r['ms_$k'] != null) k: r['ms_$k'] as int,
        },
        error: r['error'] as String?,
        mood: r['mood'] as String?,
      );
}

late final Database _db;

const _settingsSql = 'CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT)';

Future<void> openDb() async {
  _db = await openDatabase(
    '${await getDatabasesPath()}/espeak.db',
    version: 3,
    onCreate: (db, _) async {
      await db.execute(_settingsSql);
      await db.execute('''
      CREATE TABLE turns(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        heard TEXT NOT NULL,
        segments_json TEXT NOT NULL,
        wav_path TEXT,
        audio_path TEXT,
        ms_stt INTEGER, ms_llm INTEGER, ms_tts INTEGER, ms_total INTEGER,
        error TEXT,
        mood TEXT,
        chat_id INTEGER
      )''');
    },
    onUpgrade: (db, old, _) async {
      if (old < 2) await db.execute('ALTER TABLE turns ADD COLUMN mood TEXT');
      if (old < 3) {
        // old history becomes chats: a gap of more than chatGap starts a new one
        await db.execute('ALTER TABLE turns ADD COLUMN chat_id INTEGER');
        await db.execute(_settingsSql);
        final b = db.batch();
        var chat = 0, last = 0;
        for (final r in await db.query('turns', columns: ['id', 'ts'], orderBy: 'ts')) {
          final ts = r['ts'] as int;
          if (chat == 0 || ts - last > chatGap.inMilliseconds) chat = ts;
          last = ts;
          b.update('turns', {'chat_id': chat}, where: 'id = ?', whereArgs: [r['id']]);
        }
        await b.commit(noResult: true);
      }
    },
  );
}

Future<int> insertTurn(Turn t) => _db.insert('turns', t.toRow());

Future<void> updateTurn(Turn t) => _db.update('turns', t.toRow(), where: 'id = ?', whereArgs: [t.id]);

Future<void> clearTurns() => _db.delete('turns');

Future<void> deleteChatRows(int chatId) => _db.delete('turns', where: 'chat_id = ?', whereArgs: [chatId]);

/// Puts a deleted chat back (Undo), keeping the original row ids.
Future<void> restoreTurns(List<Turn> ts) async {
  final b = _db.batch();
  for (final t in ts) {
    b.insert('turns', {...t.toRow(), 'id': t.id}, conflictAlgorithm: ConflictAlgorithm.replace);
  }
  await b.commit(noResult: true);
}

Future<String?> getSetting(String k) async {
  final r = await _db.query('settings', where: 'k = ?', whereArgs: [k]);
  return r.isEmpty ? null : r.first['v'] as String?;
}

Future<void> setSetting(String k, String v) =>
    _db.insert('settings', {'k': k, 'v': v}, conflictAlgorithm: ConflictAlgorithm.replace);

/// One row of the past-chats drawer.
class ChatSummary {
  ChatSummary(this.id, this.first, this.last, this.count, this.title, this.mood);
  final int id;
  final DateTime first, last;
  final int count;
  final String title; // the first thing you said in it
  final String? mood; // Dess's mood on her latest reply
}

Future<List<ChatSummary>> chatSummaries() async {
  final rows = await _db.rawQuery('''
    SELECT chat_id, MIN(ts) AS first_ts, MAX(ts) AS last_ts, COUNT(*) AS n,
      (SELECT heard FROM turns b WHERE b.chat_id = t.chat_id AND heard != '' ORDER BY ts LIMIT 1) AS title,
      (SELECT mood FROM turns c WHERE c.chat_id = t.chat_id AND mood IS NOT NULL ORDER BY ts DESC LIMIT 1) AS mood
    FROM turns t GROUP BY chat_id ORDER BY last_ts DESC''');
  return [
    for (final r in rows)
      ChatSummary(
        r['chat_id'] as int,
        DateTime.fromMillisecondsSinceEpoch(r['first_ts'] as int),
        DateTime.fromMillisecondsSinceEpoch(r['last_ts'] as int),
        r['n'] as int,
        (r['title'] as String?) ?? '',
        r['mood'] as String?,
      ),
  ];
}

/// Latency log for the report: one row per turn.
Future<String> turnsCsv() async {
  String q(Object? v) => '"${(v ?? '').toString().replaceAll('"', '""')}"'; // CSV-escape
  final rows = (await allTurns()).map((t) => [
        t.id,
        t.ts.toIso8601String(),
        q(t.heard),
        q(t.replyText),
        t.ms['stt'] ?? '',
        t.ms['llm'] ?? '',
        t.ms['tts'] ?? '',
        t.ms['total'] ?? '',
        q(t.error),
      ].join(','));
  return ['id,time,heard,reply,stt_ms,llm_ms,tts_ms,total_ms,error', ...rows].join('\n');
}

Future<List<Turn>> turnsOfChat(int chatId) async =>
    (await _db.query('turns', where: 'chat_id = ?', whereArgs: [chatId], orderBy: 'ts')).map(Turn.fromRow).toList();

// ponytail: loads everything; page it if history ever reaches thousands of turns
Future<List<Turn>> allTurns() async => (await _db.query('turns', orderBy: 'ts')).map(Turn.fromRow).toList();
