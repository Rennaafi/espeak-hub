import 'dart:async';

import 'package:flutter/material.dart';

import 'controller.dart';
import 'dess_face.dart';

/// Entrance: black screen, a thin glowing line, Dess opens her eyes, then three boot lines tick over while the
/// real connection check runs, and the whole thing fades into the app. Tap anywhere to skip.
class BootOverlay extends StatefulWidget {
  const BootOverlay({super.key, required this.c, required this.color, required this.onDone});
  final AppController c;
  final Color color;
  final VoidCallback onDone;

  @override
  State<BootOverlay> createState() => _BootOverlayState();
}

const linkOk = Color(0xFF4ADE80); // "connected" green, shared with the status indicators

class _BootOverlayState extends State<BootOverlay> {
  int _lines = 0; // 1 name+first line, 2 cloud checking, 3 cloud result + speaker checking, 4 speaker result
  bool _fading = false, _done = false;

  @override
  void initState() {
    super.initState();
    // 'remove animations' on: no show, straight to the app
    if (WidgetsBinding.instance.platformDispatcher.accessibilityFeatures.disableAnimations) {
      WidgetsBinding.instance.addPostFrameCallback((_) => widget.onDone());
      _done = true;
    } else {
      _run();
    }
  }

  @override
  void dispose() {
    _done = true;
    super.dispose();
  }

  Future<bool> _wait(int ms) async {
    await Future<void>.delayed(Duration(milliseconds: ms));
    return mounted && !_done;
  }

  Future<void> _run() async {
    if (!await _wait(800)) return;
    setState(() => _lines = 1);
    if (!await _wait(300)) return;
    setState(() => _lines = 2);
    if (!await _wait(500)) return;
    // the cloud line settles when the real check answers (it times out after 4 s; wait at most 3)
    for (var i = 0; widget.c.workerUp == null && i < 30; i++) {
      if (!await _wait(100)) return;
    }
    setState(() => _lines = 3);
    if (!await _wait(450)) return;
    setState(() => _lines = 4);
    if (!await _wait(700)) return;
    _finish();
  }

  Future<void> _finish() async {
    if (_done) return;
    _done = true;
    setState(() => _fading = true);
    await Future<void>.delayed(const Duration(milliseconds: 400));
    if (mounted) widget.onDone();
  }

  /// One boot line: hidden, spinner while pending, then a tick or a cross with its result text.
  Widget _row(int showAt, String pending, bool? good, String done) {
    final shown = _lines >= showAt;
    final settled = _lines > showAt;
    return AnimatedOpacity(
      opacity: shown ? 1 : 0,
      duration: const Duration(milliseconds: 300),
      child: SizedBox(
        height: 28,
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          SizedBox(
            width: 16,
            height: 16,
            child: !settled
                ? CircularProgressIndicator(strokeWidth: 2, color: widget.color)
                : Icon(good == null ? Icons.remove : (good ? Icons.check : Icons.close), size: 16, color: good == null ? Colors.white38 : (good ? linkOk : Colors.redAccent)),
          ),
          const SizedBox(width: 10),
          AnimatedSwitcher(
            duration: const Duration(milliseconds: 250),
            child: Text(settled ? done : pending, key: ValueKey(settled), style: const TextStyle(color: Colors.white60, fontSize: 13, letterSpacing: .5)),
          ),
        ]),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.c;
    final cloud = c.workerUp;
    final speaker = c.speakerUp;
    // she smiles when the cloud answered, looks puzzled when it didn't
    final mood = _lines < 3 || cloud == null ? 'neutral' : (cloud ? 'happy' : 'confused');
    return Material(
      color: Colors.black,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: _finish,
        child: AnimatedOpacity(
          opacity: _fading ? 0 : 1,
          duration: const Duration(milliseconds: 400),
          child: AnimatedScale(
            scale: _fading ? 1.08 : 1,
            duration: const Duration(milliseconds: 400),
            curve: Curves.easeIn,
            child: Center(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  IgnorePointer(
                    child: SizedBox(
                      width: 260,
                      child: DessFace(phase: Phase.idle, mood: mood, color: widget.color, height: 150, compact: true, wakeAfter: .7),
                    ),
                  ),
                  const SizedBox(height: 8),
                  AnimatedOpacity(
                    opacity: _lines >= 1 ? 1 : 0,
                    duration: const Duration(milliseconds: 600),
                    child: const Text('ESPeak Hub', style: TextStyle(color: Colors.white, fontSize: 22, fontWeight: FontWeight.w300, letterSpacing: 6)),
                  ),
                  const SizedBox(height: 24),
                  SizedBox(
                    width: 190,
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      _row(1, 'Waking up', true, 'Awake'),
                      _row(2, 'Reaching the cloud', cloud, cloud == null ? 'Cloud not answering' : (cloud ? 'Cloud connected' : 'Cloud unreachable')),
                      _row(3, 'Finding the speaker', speaker, speaker == null ? 'Speaker unknown' : (speaker ? 'Speaker online' : 'Speaker offline')),
                    ]),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
