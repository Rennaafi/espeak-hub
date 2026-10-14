import 'dart:async';
import 'dart:math';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'boot.dart';
import 'controller.dart';
import 'db.dart';
import 'dess_face.dart';

// One color per state, shared by the talk bar, the glow and Dess's eyes.
Color phaseColor(Phase p, ColorScheme s) => switch (p) {
      Phase.idle => s.primary,
      Phase.listening => Colors.redAccent,
      Phase.thinking => Colors.amber,
      Phase.speaking => s.primary,
      Phase.error => s.error,
    };

const _moodEmoji = {'neutral': '😐', 'happy': '😊', 'tired': '😴', 'angry': '😠', 'confused': '😕', 'laugh': '😂'};
const _months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

String _dayLabel(DateTime d) {
  final today = DateUtils.dateOnly(DateTime.now());
  final day = DateUtils.dateOnly(d);
  if (day == today) return 'Today';
  if (day == today.subtract(const Duration(days: 1))) return 'Yesterday';
  return '${d.day} ${_months[d.month - 1]} ${d.year}';
}

String _hm(DateTime d) => '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';

class ChatScreen extends StatefulWidget {
  const ChatScreen({super.key});

  @override
  State<ChatScreen> createState() => _ChatScreenState();
}

class _ChatScreenState extends State<ChatScreen> {
  final c = AppController();
  bool _booting = true; // the entrance animation covers the app until it's done

  @override
  void dispose() {
    c.dispose();
    super.dispose();
  }

  void _settings(BuildContext context) => showModalBottomSheet<void>(
        context: context,
        showDragHandle: true,
        builder: (sheet) => SafeArea(
          child: ListenableBuilder(
            listenable: c,
            builder: (_, _) => Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                SwitchListTile(
                  secondary: const Icon(Icons.speed_outlined),
                  title: const Text('Show latency under replies'),
                  subtitle: const Text('Long-press any reply to peek at its numbers'),
                  value: c.showLatency,
                  onChanged: c.setShowLatency,
                ),
                ListTile(
                  leading: const Icon(Icons.table_chart_outlined),
                  title: const Text('Export latency log (CSV)'),
                  onTap: () async {
                    Navigator.pop(sheet);
                    final messenger = ScaffoldMessenger.of(context);
                    final path = await c.exportLog();
                    messenger.showSnackBar(SnackBar(content: Text('Saved to $path')));
                  },
                ),
                ListTile(
                  leading: Icon(Icons.delete_outline, color: Theme.of(context).colorScheme.error),
                  title: const Text('Clear all history'),
                  subtitle: const Text('Deletes every chat, saved reply and the latency log'),
                  onTap: () async {
                    Navigator.pop(sheet);
                    final ok = await showDialog<bool>(
                      context: context,
                      builder: (d) => AlertDialog(
                        title: const Text('Clear all history?'),
                        content: const Text('This also deletes the latency log. Export it first if you need it.'),
                        actions: [
                          TextButton(onPressed: () => Navigator.pop(d, false), child: const Text('Cancel')),
                          FilledButton(onPressed: () => Navigator.pop(d, true), child: const Text('Clear')),
                        ],
                      ),
                    );
                    if (ok == true) await c.clearHistory();
                  },
                ),
              ],
            ),
          ),
        ),
      );

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return ListenableBuilder(
      listenable: c,
      builder: (context, _) {
        final color = phaseColor(c.phase, scheme);
        final calm = c.phase == Phase.idle;
        final scaffold = Scaffold(
          drawer: Drawer(child: _ChatDrawer(c)),
          appBar: AppBar(
            centerTitle: true,
            title: _Dess(c, color),
            actions: [
              _LinkIcon(c),
              IconButton(icon: const Icon(Icons.tune), tooltip: 'Settings', onPressed: () => _settings(context)),
            ],
          ),
          // soft glow from the bottom, tinted by the current state
          body: AnimatedContainer(
            duration: const Duration(milliseconds: 500),
            decoration: BoxDecoration(
              gradient: RadialGradient(
                center: const Alignment(0, 1.25),
                radius: 1.0,
                colors: [color.withValues(alpha: calm ? 0.07 : 0.24), Colors.transparent],
              ),
            ),
            child: Column(
              children: [
                _LinkBanner(c),
                Expanded(
                  // the top edge fades out instead of cutting bubbles in half
                  child: ShaderMask(
                    blendMode: BlendMode.dstIn,
                    shaderCallback: (r) => LinearGradient(
                      begin: Alignment.topCenter,
                      end: Alignment.bottomCenter,
                      colors: const [Colors.transparent, Colors.black],
                      stops: [0, min(1, 28 / r.height)],
                    ).createShader(r),
                    child: c.turns.isEmpty ? const _EmptyState() : _Timeline(c),
                  ),
                ),
                _BottomBar(c),
              ],
            ),
          ),
        );
        if (!_booting) return scaffold;
        return Stack(children: [
          scaffold,
          Positioned.fill(child: BootOverlay(c: c, color: scheme.primary, onDone: () => setState(() => _booting = false))),
        ]);
      },
    );
  }
}

/// Dess in the app bar: small, frameless, her color follows the phase (angry = red).
class _Dess extends StatelessWidget {
  const _Dess(this.c, this.tint);
  final AppController c;
  final Color tint;

  @override
  Widget build(BuildContext context) {
    final target = c.faceMood == 'angry' ? Colors.redAccent : tint;
    return SizedBox(
      width: 132,
      height: 48,
      child: TweenAnimationBuilder<Color?>(
        tween: ColorTween(end: target),
        duration: const Duration(milliseconds: 350),
        builder: (_, col, _) => DessFace(phase: c.phase, mood: c.faceMood, color: col ?? target, height: 48, compact: true),
      ),
    );
  }
}

class _EmptyState extends StatelessWidget {
  const _EmptyState();

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    return Center(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text('Hi, I\'m Dess.', style: t.textTheme.headlineSmall),
            const SizedBox(height: 8),
            Text(
              'Hold the bar below, talk, then let go.',
              textAlign: TextAlign.center,
              style: t.textTheme.bodyMedium?.copyWith(color: t.colorScheme.onSurfaceVariant),
            ),
          ],
        ),
      ),
    );
  }
}

class _Timeline extends StatelessWidget {
  const _Timeline(this.c);
  final AppController c;

  @override
  Widget build(BuildContext context) {
    final items = <Widget>[];
    DateTime? lastDay;
    for (final t in c.turns) {
      final day = DateUtils.dateOnly(t.ts);
      if (day != lastDay) items.add(_DayHeader(_dayLabel(t.ts)));
      lastDay = day;
      if (t.error != null) {
        items.add(const _Bubble('🎤 Voice message (not sent)', mine: true));
        items.add(_ErrorBubble(t.error!, onRetry: () => c.retry(t)));
        continue;
      }
      final fresh = identical(t, c.turns.last) && DateTime.now().difference(t.ts) < const Duration(seconds: 5);
      items.add(_Pop(key: ValueKey('h${t.id}'), animate: fresh, fromRight: true, child: _Bubble(t.heard, mine: true)));
      items.add(
        _Pop(
          key: ValueKey('r${t.id}'),
          animate: fresh,
          fromRight: false,
          child: _Bubble(
            t.replyText,
            mine: false,
            typing: fresh,
            onLongPress: () {
              final ms = t.ms;
              HapticFeedback.selectionClick();
              ScaffoldMessenger.of(context)
                ..hideCurrentSnackBar()
                ..showSnackBar(SnackBar(content: Text('STT ${ms['stt']} · LLM ${ms['llm']} · TTS ${ms['tts']} = ${ms['total']} ms')));
            },
          ),
        ),
      );
      items.add(_ReplyFooter(t, showLatency: c.showLatency, onReplay: () => c.replay(t)));
    }
    // reverse: true keeps the newest turn pinned to the bottom, like any chat app
    return ListView(reverse: true, padding: const EdgeInsets.fromLTRB(16, 24, 16, 8), children: items.reversed.toList());
  }
}

class _ErrorBubble extends StatelessWidget {
  const _ErrorBubble(this.error, {required this.onRetry});
  final String error;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final s = Theme.of(context).colorScheme;
    return Align(
      alignment: Alignment.centerLeft,
      child: Padding(
        padding: const EdgeInsets.only(top: 4, bottom: 12),
        child: Material(
          color: s.errorContainer,
          borderRadius: BorderRadius.circular(20),
          child: InkWell(
            borderRadius: BorderRadius.circular(20),
            onTap: onRetry,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(Icons.refresh, size: 20, color: s.onErrorContainer),
                  const SizedBox(width: 8),
                  Flexible(
                    child: Text(
                      "Couldn't reach the server ($error)\nTap to retry",
                      style: TextStyle(color: s.onErrorContainer),
                    ),
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

class _DayHeader extends StatelessWidget {
  const _DayHeader(this.label);
  final String label;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 12),
      child: Center(
        child: Text(label, style: t.textTheme.labelMedium?.copyWith(color: t.colorScheme.onSurfaceVariant.withValues(alpha: .7))),
      ),
    );
  }
}

class _ReplyFooter extends StatelessWidget {
  const _ReplyFooter(this.t, {required this.showLatency, required this.onReplay});
  final Turn t;
  final bool showLatency;
  final VoidCallback onReplay;

  @override
  Widget build(BuildContext context) {
    final th = Theme.of(context);
    final ms = t.ms;
    final muted = th.colorScheme.onSurfaceVariant.withValues(alpha: .6);
    final emoji = _moodEmoji[t.mood] ?? '';
    return Padding(
      padding: const EdgeInsets.only(left: 6, bottom: 10),
      child: Row(
        children: [
          Flexible(
            child: Text(
              // stt/llm/tts = total, the proposal's per-stage metric
              '${_hm(t.ts)} $emoji${showLatency ? '  ·  ${ms['stt']}/${ms['llm']}/${ms['tts']} = ${ms['total']} ms' : ''}',
              style: th.textTheme.bodySmall?.copyWith(color: muted, fontFamily: showLatency ? 'monospace' : null),
            ),
          ),
          if (t.wavPath != null) // speaker turns have no local audio
            IconButton(
              onPressed: onReplay,
              icon: Icon(Icons.play_circle_outline, size: 20, color: muted),
              visualDensity: VisualDensity.compact,
              tooltip: 'Replay',
            ),
        ],
      ),
    );
  }
}

class _Bubble extends StatelessWidget {
  const _Bubble(this.text, {required this.mine, this.typing = false, this.onLongPress});
  final String text;
  final bool mine; // you on the right, AI on the left
  final bool typing; // type the text out letter by letter (newest reply only)
  final VoidCallback? onLongPress;

  @override
  Widget build(BuildContext context) {
    final s = Theme.of(context).colorScheme;
    final style = TextStyle(color: mine ? s.onPrimaryContainer : s.onSurface, height: 1.3);
    return Align(
      alignment: mine ? Alignment.centerRight : Alignment.centerLeft,
      child: GestureDetector(
        onLongPress: onLongPress,
        child: Container(
          constraints: BoxConstraints(maxWidth: MediaQuery.sizeOf(context).width * 0.78),
          margin: const EdgeInsets.symmetric(vertical: 4),
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
          decoration: BoxDecoration(
            color: mine ? s.primaryContainer.withValues(alpha: .85) : s.surfaceContainerHigh,
            borderRadius: BorderRadius.only(
              topLeft: const Radius.circular(20),
              topRight: const Radius.circular(20),
              bottomLeft: Radius.circular(mine ? 20 : 5),
              bottomRight: Radius.circular(mine ? 5 : 20),
            ),
          ),
          child: typing
              ? TweenAnimationBuilder<int>(
                  tween: IntTween(begin: 0, end: text.length),
                  duration: Duration(milliseconds: min(text.length * 28, 3000)),
                  builder: (_, n, _) => Stack(children: [
                    Opacity(opacity: 0, child: Text(text, style: style)), // reserves the final size, no jumping
                    Text(text.substring(0, n), style: style),
                  ]),
                )
              : Text(text, style: style),
        ),
      ),
    );
  }
}

/// Slides + pops a new bubble in from its own side. Old turns pass animate: false and just appear.
class _Pop extends StatelessWidget {
  const _Pop({super.key, required this.animate, required this.fromRight, required this.child});
  final bool animate, fromRight;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    if (!animate || MediaQuery.disableAnimationsOf(context)) return child;
    return TweenAnimationBuilder<double>(
      tween: Tween(begin: 0, end: 1),
      duration: const Duration(milliseconds: 450),
      curve: Curves.easeOutBack,
      child: child,
      builder: (_, v, child) => Opacity(
        opacity: v.clamp(0, 1),
        child: Transform.translate(
          offset: Offset((fromRight ? 1 : -1) * 24 * (1 - v), 16 * (1 - v)),
          child: Transform.scale(
            scale: .85 + .15 * v,
            alignment: fromRight ? Alignment.bottomRight : Alignment.bottomLeft,
            child: child,
          ),
        ),
      ),
    );
  }
}

/// Phone/speaker switch + hold-to-talk bar in one pill-shaped row.
class _BottomBar extends StatelessWidget {
  const _BottomBar(this.c);
  final AppController c;

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      top: false,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 4, 16, 12),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (c.hint != null) _HintPill(c.hint!, isError: c.phase == Phase.error),
            _LangSwitch(c),
            Row(
              children: [
                _TargetSwitch(c),
                const SizedBox(width: 12),
                Expanded(child: _TalkBar(c)),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _LangSwitch extends StatelessWidget {
  const _LangSwitch(this.c);
  final AppController c;

  @override
  Widget build(BuildContext context) {
    final s = Theme.of(context).colorScheme;
    Widget chip(String lang, String label) {
      final on = c.lang == lang;
      return GestureDetector(
        onTap: () {
          HapticFeedback.selectionClick();
          c.setLang(lang);
        },
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 200),
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
          decoration: BoxDecoration(borderRadius: BorderRadius.circular(20), color: on ? s.primaryContainer : Colors.transparent),
          child: Text(label, style: TextStyle(fontSize: 13, color: on ? s.onPrimaryContainer : s.onSurfaceVariant)),
        ),
      );
    }

    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Container(
        padding: const EdgeInsets.all(3),
        decoration: BoxDecoration(color: s.surfaceContainerHigh, borderRadius: BorderRadius.circular(24)),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          chip('en', 'English'),
          chip('buddy', 'Buddy'),
          chip('ko', '한국어'),
        ]),
      ),
    );
  }
}

class _TargetSwitch extends StatelessWidget {
  const _TargetSwitch(this.c);
  final AppController c;

  @override
  Widget build(BuildContext context) {
    final s = Theme.of(context).colorScheme;
    Widget btn(String target, IconData icon, String tip) {
      final on = c.target == target;
      return Tooltip(
        message: tip,
        child: GestureDetector(
          onTap: () {
            HapticFeedback.selectionClick();
            c.setTarget(target);
          },
          child: AnimatedContainer(
            duration: const Duration(milliseconds: 200),
            width: 46,
            height: 46,
            decoration: BoxDecoration(shape: BoxShape.circle, color: on ? s.primaryContainer : Colors.transparent),
            child: Stack(alignment: Alignment.center, children: [
              Icon(icon, size: 22, color: on ? s.onPrimaryContainer : s.onSurfaceVariant),
              if (target == 'speaker' && c.speakerUp != null) // is the ESP32 connected to the cloud right now?
                Positioned(
                  top: 9,
                  right: 9,
                  child: Container(
                    width: 9,
                    height: 9,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      color: c.speakerUp! ? linkOk : s.error,
                      border: Border.all(color: Colors.black, width: 1.5),
                    ),
                  ),
                ),
            ]),
          ),
        ),
      );
    }

    return Container(
      padding: const EdgeInsets.all(5),
      decoration: BoxDecoration(color: s.surfaceContainerHigh, borderRadius: BorderRadius.circular(40)),
      child: Row(children: [
        btn('phone', Icons.smartphone, 'Play on phone'),
        btn('speaker', Icons.speaker, 'Play on the ESP32 speaker'),
      ]),
    );
  }
}

class _TalkBar extends StatefulWidget {
  const _TalkBar(this.c);
  final AppController c;

  @override
  State<_TalkBar> createState() => _TalkBarState();
}

class _TalkBarState extends State<_TalkBar> with SingleTickerProviderStateMixin {
  late final _pulse = AnimationController(vsync: this, duration: const Duration(milliseconds: 1100));

  bool get _active => widget.c.phase == Phase.listening || widget.c.phase == Phase.speaking;

  // only animate while listening/speaking, so an idle screen costs no frames
  void _sync() {
    if (!_active) {
      _pulse.reset();
    } else if (!_pulse.isAnimating) {
      _pulse.repeat();
    }
  }

  @override
  void initState() {
    super.initState();
    widget.c.addListener(_sync);
  }

  @override
  void dispose() {
    widget.c.removeListener(_sync);
    _pulse.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.c;
    final scheme = Theme.of(context).colorScheme;
    final color = phaseColor(c.phase, scheme);
    final filled = c.phase != Phase.idle && c.phase != Phase.error;
    final label = switch (c.phase) {
      Phase.idle || Phase.error => 'Hold to talk',
      Phase.listening => 'Listening…',
      Phase.thinking => 'Thinking…',
      Phase.speaking => 'Speaking…',
    };
    final fg = filled ? Colors.black87 : scheme.onSurface;

    final bar = AnimatedContainer(
      duration: const Duration(milliseconds: 250),
      height: 62,
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(40),
        color: filled ? null : scheme.surfaceContainerHigh,
        gradient: filled ? LinearGradient(colors: [color, Color.lerp(color, Colors.black, .3)!]) : null,
        border: Border.all(color: color.withValues(alpha: filled ? 0 : .45), width: 1.5),
        boxShadow: [BoxShadow(color: color.withValues(alpha: filled ? .45 : .12), blurRadius: 24)],
      ),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          SizedBox(
            width: 28,
            height: 28,
            child: switch (c.phase) {
              Phase.thinking => Padding(padding: const EdgeInsets.all(3), child: CircularProgressIndicator(strokeWidth: 3, color: fg)),
              Phase.listening || Phase.speaking => _Bars(_pulse, fg),
              Phase.error => Icon(Icons.mic_off, color: fg),
              Phase.idle => Icon(Icons.mic_none, color: fg),
            },
          ),
          const SizedBox(width: 10),
          AnimatedSwitcher(
            duration: const Duration(milliseconds: 200),
            child: Text(label, key: ValueKey(label), style: Theme.of(context).textTheme.titleMedium?.copyWith(color: fg)),
          ),
        ],
      ),
    );

    // Listener (not GestureDetector) fires on finger down/up instantly, no long-press delay
    return Listener(
      onPointerDown: (_) {
        HapticFeedback.mediumImpact();
        c.pressDown();
      },
      onPointerUp: (_) {
        HapticFeedback.selectionClick();
        c.release();
      },
      onPointerCancel: (_) => c.release(),
      child: AnimatedScale(
        scale: c.phase == Phase.listening ? 1.03 : 1,
        duration: const Duration(milliseconds: 150),
        child: Stack(
          clipBehavior: Clip.none,
          children: [
            // expanding, fading ring while listening
            if (c.phase == Phase.listening)
              Positioned.fill(
                child: AnimatedBuilder(
                  animation: _pulse,
                  builder: (_, _) => Transform.scale(
                    scaleX: 1 + .08 * _pulse.value,
                    scaleY: 1 + .3 * _pulse.value,
                    child: DecoratedBox(
                      decoration: BoxDecoration(
                        borderRadius: BorderRadius.circular(40),
                        border: Border.all(color: color.withValues(alpha: .6 * (1 - _pulse.value)), width: 2),
                      ),
                    ),
                  ),
                ),
              ),
            bar,
          ],
        ),
      ),
    );
  }
}

/// Five little equalizer bars dancing while she listens or speaks.
class _Bars extends StatelessWidget {
  const _Bars(this.pulse, this.color);
  final Animation<double> pulse;
  final Color color;

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
        animation: pulse,
        builder: (_, _) => Row(
          mainAxisAlignment: MainAxisAlignment.spaceEvenly,
          crossAxisAlignment: CrossAxisAlignment.center,
          children: [
            for (var i = 0; i < 5; i++)
              Container(
                width: 3.5,
                height: 6 + 18 * (.5 + .5 * sin(2 * pi * pulse.value + i * 1.3)),
                decoration: BoxDecoration(color: color, borderRadius: BorderRadius.circular(2)),
              ),
          ],
        ),
      );
}

class _HintPill extends StatelessWidget {
  const _HintPill(this.text, {required this.isError});
  final String text;
  final bool isError;

  @override
  Widget build(BuildContext context) {
    final s = Theme.of(context).colorScheme;
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
      decoration: BoxDecoration(
        color: isError ? s.errorContainer : s.surfaceContainerHigh,
        borderRadius: BorderRadius.circular(20),
      ),
      child: Text(
        text,
        textAlign: TextAlign.center,
        style: TextStyle(color: isError ? s.onErrorContainer : s.onSurfaceVariant),
      ),
    );
  }
}

/// Past chats: tap to open (and keep talking in it), swipe to delete with Undo.
class _ChatDrawer extends StatefulWidget {
  const _ChatDrawer(this.c);
  final AppController c;

  @override
  State<_ChatDrawer> createState() => _ChatDrawerState();
}

class _ChatDrawerState extends State<_ChatDrawer> {
  List<ChatSummary>? _list; // null while loading
  List<Turn>? _pending; // a just-deleted chat that Undo can still bring back
  Timer? _timer;
  ScaffoldMessengerState? _messenger;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _messenger = ScaffoldMessenger.of(context);
  }

  @override
  void dispose() {
    _timer?.cancel();
    final gone = _pending, m = _messenger, c = widget.c;
    if (gone != null && m != null) {
      // drawer closed with an Undo still open: hand it over to a normal snackbar
      Future.microtask(
        () => m
            .showSnackBar(SnackBar(
              content: const Text('Chat deleted'),
              action: SnackBarAction(label: 'Undo', onPressed: () => c.restoreChat(gone)),
            ))
            .closed
            .then((why) {
          if (why != SnackBarClosedReason.action) AppController.discardFiles(gone);
        }),
      );
    }
    super.dispose();
  }

  /// The audio files of a deleted chat are only removed once Undo can no longer be pressed.
  void _stage(List<Turn> gone) {
    if (_pending != null) AppController.discardFiles(_pending!);
    _timer?.cancel();
    setState(() => _pending = gone);
    _timer = Timer(const Duration(seconds: 5), () {
      AppController.discardFiles(gone);
      if (mounted && identical(_pending, gone)) setState(() => _pending = null);
    });
  }

  Future<void> _undo() async {
    final gone = _pending!;
    _timer?.cancel();
    setState(() => _pending = null);
    await widget.c.restoreChat(gone);
    _load();
  }

  Future<void> _load() async {
    final l = await widget.c.chatsList();
    if (mounted) setState(() => _list = l);
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.c;
    final t = Theme.of(context);
    return SafeArea(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 20, 20, 8),
            child: Text('Chats', style: t.textTheme.headlineSmall),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
            child: FilledButton.tonalIcon(
              onPressed: () {
                Navigator.pop(context);
                c.newChat();
              },
              icon: const Icon(Icons.add),
              label: const Text('New chat'),
            ),
          ),
          const SizedBox(height: 8),
          Expanded(
            child: Builder(
              builder: (_) {
                final list = _list;
                if (list == null) return const SizedBox.shrink();
                if (list.isEmpty) {
                  return Center(child: Text('No past chats yet', style: TextStyle(color: t.colorScheme.onSurfaceVariant)));
                }
                final rows = <Widget>[];
                String? lastLabel;
                for (final ch in list) {
                  final label = _dayLabel(ch.last);
                  if (label != lastLabel) {
                    rows.add(Padding(
                      padding: const EdgeInsets.fromLTRB(20, 14, 20, 4),
                      child: Text(label, style: t.textTheme.labelMedium?.copyWith(color: t.colorScheme.onSurfaceVariant)),
                    ));
                  }
                  lastLabel = label;
                  rows.add(
                    Dismissible(
                      key: ValueKey(ch.id),
                      direction: DismissDirection.endToStart,
                      background: Container(
                        color: t.colorScheme.errorContainer,
                        alignment: Alignment.centerRight,
                        padding: const EdgeInsets.only(right: 24),
                        child: Icon(Icons.delete_outline, color: t.colorScheme.onErrorContainer),
                      ),
                      onDismissed: (_) async {
                        setState(() => list.removeWhere((x) => x.id == ch.id)); // Dismissible must leave the tree right now
                        _stage(await c.deleteChat(ch.id));
                      },
                      child: ListTile(
                        selected: ch.id == c.chatId,
                        title: Text(ch.title.isEmpty ? '🎤 Voice message' : ch.title, maxLines: 1, overflow: TextOverflow.ellipsis),
                        subtitle: Text('${_hm(ch.first)} · ${ch.count} ${ch.count == 1 ? 'exchange' : 'exchanges'}'),
                        trailing: Text(_moodEmoji[ch.mood] ?? '', style: const TextStyle(fontSize: 20)),
                        onTap: () {
                          Navigator.pop(context);
                          c.openChat(ch.id);
                        },
                      ),
                    ),
                  );
                }
                return ListView(children: rows);
              },
            ),
          ),
          if (_pending != null)
            Container(
              margin: const EdgeInsets.all(12),
              padding: const EdgeInsets.only(left: 16),
              decoration: BoxDecoration(color: t.colorScheme.surfaceContainerHighest, borderRadius: BorderRadius.circular(16)),
              child: Row(
                children: [
                  const Expanded(child: Text('Chat deleted')),
                  TextButton(onPressed: _undo, child: const Text('Undo')),
                ],
              ),
            ),
        ],
      ),
    );
  }
}

/// App-bar cloud icon: spinner while checking, green when the Worker answers, red when not. Tap re-checks.
class _LinkIcon extends StatelessWidget {
  const _LinkIcon(this.c);
  final AppController c;

  @override
  Widget build(BuildContext context) {
    final s = Theme.of(context).colorScheme;
    final (Widget icon, String tip) = switch (c.workerUp) {
      null => (const SizedBox(key: ValueKey('chk'), width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.amber)), 'Checking…'),
      true => (const Icon(Icons.cloud_done_outlined, key: ValueKey('on'), size: 22, color: linkOk), 'Connected'),
      false => (Icon(Icons.cloud_off_outlined, key: const ValueKey('off'), size: 22, color: s.error), 'Offline, tap to retry'),
    };
    return IconButton(
      tooltip: tip,
      onPressed: () {
        HapticFeedback.selectionClick();
        c.refreshLink(quiet: false);
      },
      icon: AnimatedSwitcher(
        duration: const Duration(milliseconds: 250),
        transitionBuilder: (child, a) => ScaleTransition(scale: a, child: FadeTransition(opacity: a, child: child)),
        child: icon,
      ),
    );
  }
}

/// Slim strip that slides in only when something is down; tap re-checks.
class _LinkBanner extends StatelessWidget {
  const _LinkBanner(this.c);
  final AppController c;

  @override
  Widget build(BuildContext context) {
    final s = Theme.of(context).colorScheme;
    final msg = c.workerUp == false
        ? ('No connection to the cloud', Icons.wifi_off)
        : (c.target == 'speaker' && c.speakerUp == false ? ('Speaker is offline: power it on or switch to phone', Icons.speaker_outlined) : null);
    return AnimatedSize(
      duration: const Duration(milliseconds: 250),
      curve: Curves.easeOut,
      alignment: Alignment.topCenter,
      child: msg == null
          ? const SizedBox(width: double.infinity)
          : InkWell(
              onTap: () => c.refreshLink(quiet: false),
              child: Container(
                width: double.infinity,
                padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                color: s.errorContainer.withValues(alpha: .35),
                child: Row(children: [
                  Icon(msg.$2, size: 16, color: s.error),
                  const SizedBox(width: 8),
                  Expanded(child: Text(msg.$1, style: TextStyle(color: s.error, fontSize: 13))),
                  Text('Retry', style: TextStyle(color: s.error, fontSize: 13, fontWeight: FontWeight.w600)),
                ]),
              ),
            ),
    );
  }
}
