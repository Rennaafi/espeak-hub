import 'dart:math';

import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter/services.dart';

import 'controller.dart';

/// Dess's face: the same eyes as the ESP32 OLED, drawn with a CustomPainter.
/// Moods are neutral / happy / tired / angry / confused / laugh (the Worker's list).
class DessFace extends StatefulWidget {
  const DessFace({super.key, required this.phase, required this.mood, required this.color, this.height = 190, this.compact = false, this.wakeAfter = 0});

  final double wakeAfter; // seconds her lids stay shut after the face first appears (the boot animation)
  final Phase phase;
  final String mood;
  final Color color;
  final double height;
  final bool compact; // just the eyes (no panel), small enough for an app bar

  @override
  State<DessFace> createState() => _DessFaceState();
}

class _Spark {
  _Spark(this.born, this.ox, this.oy, this.vx, this.vy, this.size);
  final double born, ox, oy, vx, vy, size; // ox/oy = start as a fraction of the panel, vx/vy in px/s
}

class _DessFaceState extends State<DessFace> with SingleTickerProviderStateMixin {
  static const _sleepAfter = 120.0; // seconds idle, same as the OLED
  static const _pokeLength = 1.2;

  final _rng = Random();
  final _repaint = ValueNotifier<int>(0);
  late final Ticker _ticker;

  // everything below is eased every frame and read by the painter
  double t = 0;
  double open = 0; // 0 = lids shut (boot, sleep), 1 = open
  double blink = 0;
  double droop = 0, tilt = 0, happy = 0, wide = 1, confused = 0;
  double lookX = 0, lookY = 0;
  double shakeX = 0, shakeY = 0;
  double yawn = 0, sigh = 0; // 0..1 envelopes of the rare idle quirks
  final sparks = <_Spark>[];

  double _lookTx = 0, _lookTy = 0, _nextLook = 1, _nextBlink = 1.5, _blinkStart = -1;
  double _moodSince = 0, _idleSince = 0, _pokeUntil = -1;
  double _nextQuirk = 30, _quirkStart = -9; // a yawn or a sigh at most about once a minute
  bool _yawnNext = true;
  bool _still = false; // Android 'remove animations': she only blinks

  bool get sleeping => t - _idleSince > _sleepAfter;
  String get _mood => t < _pokeUntil ? 'laugh' : widget.mood;

  @override
  void initState() {
    super.initState();
    _ticker = createTicker(_tick)..start();
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _still = MediaQuery.disableAnimationsOf(context);
  }

  @override
  void didUpdateWidget(DessFace old) {
    super.didUpdateWidget(old);
    if (old.phase != widget.phase || old.mood != widget.mood) _idleSince = t; // any event wakes her
    if (old.mood != widget.mood) {
      _moodSince = t;
      if (widget.mood == 'laugh') _burst();
    }
  }

  @override
  void dispose() {
    _ticker.dispose();
    _repaint.dispose();
    super.dispose();
  }

  void _burst() {
    if (_still) return;
    for (var i = 0; i < 7; i++) {
      sparks.add(_Spark(t, _rng.nextDouble() * .6 - .3, _rng.nextDouble() * .4 - .2, _rng.nextDouble() * 80 - 40,
          -40 - _rng.nextDouble() * 60, 6 + _rng.nextDouble() * 7));
    }
  }

  void _poke() {
    HapticFeedback.lightImpact();
    _idleSince = t;
    _pokeUntil = t + _pokeLength;
    _moodSince = t;
    if (!_still) _burst();
  }

  void _tick(Duration elapsed) {
    final now = elapsed.inMicroseconds / 1e6;
    final dt = min(now - t, .05);
    t = now;
    final k = 1 - exp(-dt * 12); // ease factor for lid shapes
    final kl = 1 - exp(-dt * 8); // slower, for where she looks
    final m = _mood;
    final p = widget.phase;

    // lid shape per mood, eased so a change slides instead of snapping
    final (td, tt, th) = switch (m) {
      'happy' => (0.0, 0.0, .5),
      'tired' => (.45, 0.0, 0.0),
      'angry' => (.1, .4, 0.0),
      'laugh' => (0.0, 0.0, .65),
      _ => (0.0, 0.0, 0.0),
    };
    droop += (td + .35 * sigh - droop) * k;
    tilt += (tt - tilt) * k;
    happy += (th - happy) * k;
    confused += ((m == 'confused' ? 1.0 : 0.0) - confused) * k;
    wide += ((p == Phase.listening ? 1.15 : 1.0) - wide) * k;
    final shut = sleeping || t < widget.wakeAfter;
    open += ((shut ? .06 : 1.0) - open) * (1 - exp(-dt * (sleeping ? 3 : 9)));

    // blink every 2-5 s
    if (t > _nextBlink) {
      _blinkStart = t;
      _nextBlink = t + 2 + _rng.nextDouble() * 3.5;
    }
    final b = t - _blinkStart;
    blink = max(_blinkStart >= 0 && b < .18 ? sin(pi * b / .18) : 0, .9 * yawn);

    // where she looks: wanders when idle, up-and-sway when thinking, straight at you when listening
    if (p == Phase.thinking) {
      _lookTx = sin(t * 1.5) * .7;
      _lookTy = -.8;
    } else if (p == Phase.listening) {
      _lookTx = 0;
      _lookTy = 0;
    } else if (_still) {
      _lookTx = _lookTy = 0;
    } else if (t > _nextLook) {
      _lookTx = _rng.nextDouble() * 2 - 1;
      _lookTy = (_rng.nextDouble() * 2 - 1) * .5;
      // idle: a slow glance every 6-12 s so she never catches the eye; speaking: livelier
      _nextLook = t + (p == Phase.idle ? 6 + _rng.nextDouble() * 6 : 1.2 + _rng.nextDouble() * 3);
    }
    final kLook = p == Phase.idle ? 1 - exp(-dt * 3) : kl;
    lookX += (_lookTx - lookX) * kLook;
    lookY += (_lookTy + .5 * sigh - lookY) * kLook;

    // rare quirk: alternate a yawn (slow squeeze shut) and a sigh (droop + glance down)
    final calm = p == Phase.idle && m == 'neutral' && !sleeping && !_still;
    if (calm && t > _nextQuirk && t - _quirkStart > 2) {
      _quirkStart = t;
      _nextQuirk = t + 25 + _rng.nextDouble() * 35;
    }
    final q = (t - _quirkStart) / 1.8;
    final env = q >= 0 && q < 1 && calm ? sin(pi * q) : 0.0;
    yawn = _yawnNext ? env : 0;
    sigh = _yawnNext ? 0 : env;
    if (q >= 1 && q < 1.05) _yawnNext = !_yawnNext;

    // laugh bounces, confused shakes: once (0.9 s), then she just holds the mood quietly
    shakeX = shakeY = 0;
    final age = t - _moodSince;
    if (!_still) {
      if (age < .9) {
        final e = sin(pi * age / .9);
        if (m == 'laugh') shakeY = sin(t * 24) * 5 * e;
        if (m == 'confused') shakeX = sin(t * 20) * 6 * e;
      }
      if (p == Phase.speaking) shakeY += sin(t * 11) * 2; // little talking bob
      if (p == Phase.idle && !sleeping) shakeY += sin(t * .9) * 2; // barely-there float
    }

    sparks.removeWhere((s) => t - s.born > 1.1);
    _repaint.value++;
  }

  @override
  Widget build(BuildContext context) => GestureDetector(
        onTap: _poke,
        child: SizedBox(
          height: widget.height,
          width: double.infinity,
          child: CustomPaint(painter: _FacePainter(this)),
        ),
      );
}

class _FacePainter extends CustomPainter {
  _FacePainter(this.s) : super(repaint: s._repaint);
  final _DessFaceState s;

  @override
  bool shouldRepaint(_FacePainter old) => true;

  /// One eye: a rounded rect, minus the top lid (droop / angry slant), minus an oval from below (happy squint).
  Path _eye(Offset c, double w, double h, {required bool left}) {
    var p = Path()..addRRect(RRect.fromRectAndRadius(Rect.fromCenter(center: c, width: w, height: h), Radius.circular(w * .3)));
    final top = c.dy - h / 2, bot = c.dy + h / 2, l = c.dx - w / 2 - 2, r = c.dx + w / 2 + 2;
    if (s.droop > .01 || s.tilt.abs() > .01) {
      final outer = left ? l : r, inner = left ? r : l; // angry lids point down toward the nose
      final lid = Path()
        ..moveTo(outer, top - 2)
        ..lineTo(inner, top - 2)
        ..lineTo(inner, top + h * (s.droop + s.tilt))
        ..lineTo(outer, top + h * s.droop)
        ..close();
      p = Path.combine(PathOperation.difference, p, lid);
    }
    if (s.happy > .01) {
      final oval = Path()
        ..addOval(Rect.fromCenter(center: Offset(c.dx, bot + .7 * h - s.happy * .5 * h), width: w * 1.5, height: 1.4 * h));
      p = Path.combine(PathOperation.difference, p, oval);
    }
    return p;
  }

  void _sparkle(Canvas canvas, Offset c, double r, Paint paint) {
    final p = Path()
      ..moveTo(c.dx, c.dy - r)
      ..quadraticBezierTo(c.dx, c.dy, c.dx + r, c.dy)
      ..quadraticBezierTo(c.dx, c.dy, c.dx, c.dy + r)
      ..quadraticBezierTo(c.dx, c.dy, c.dx - r, c.dy)
      ..quadraticBezierTo(c.dx, c.dy, c.dx, c.dy - r);
    canvas.drawPath(p, paint);
  }

  @override
  void paint(Canvas canvas, Size size) {
    final color = s.widget.color;
    final compact = s.widget.compact;
    canvas.save();
    if (!compact) {
      final panel = RRect.fromRectAndRadius(Offset.zero & size, const Radius.circular(28));
      canvas.drawRRect(
          panel, Paint()..color = color.withValues(alpha: .2)..maskFilter = const MaskFilter.blur(BlurStyle.outer, 20));
      canvas.drawRRect(panel, Paint()..color = const Color(0xFF05090B));
      canvas.drawRRect(
          panel.deflate(1), Paint()..color = color.withValues(alpha: .45)..style = PaintingStyle.stroke..strokeWidth = 2);
      canvas.clipRRect(panel);
    }

    final w = compact ? size.height * .4 : min(size.width * .2, size.height * .34), h = w * 1.2, gap = w * (compact ? .7 : .6);
    final u = w / 64.6; // scale for pixel-sized offsets, so compact mode moves proportionally less
    final cx = size.width / 2, cy = size.height / 2;
    final lid = max(.04, s.open * (1 - s.blink)); // how open, 0..1
    for (final left in [true, false]) {
      final odd = !left && s.confused > 0; // confused: right eye smaller and raised
      final eh = h * s.wide * lid * (odd ? 1 - .25 * s.confused : 1);
      final c = Offset(
        cx + (left ? -1 : 1) * (gap / 2 + w / 2) + s.lookX * w * .3 + s.shakeX * u,
        cy + s.lookY * h * .18 + s.shakeY * u - (odd ? 8 * u * s.confused : 0),
      );
      final eye = _eye(c, w, eh, left: left);
      canvas.drawPath(eye, Paint()..color = color.withValues(alpha: .55)..maskFilter = MaskFilter.blur(BlurStyle.normal, max(4, 14 * u)));
      canvas.drawPath(eye, Paint()..color = color);
      canvas.save(); // glint
      canvas.clipPath(eye);
      canvas.drawCircle(Offset(c.dx - w * .2, c.dy - eh * .26), w * .09, Paint()..color = Colors.white.withValues(alpha: .55));
      canvas.restore();
    }

    for (final sp in s.sparks) {
      final age = s.t - sp.born;
      final fade = 1 - age / 1.1;
      _sparkle(
        canvas,
        Offset(size.width * (.5 + sp.ox) + sp.vx * age * u, size.height * (.5 + sp.oy) + sp.vy * age * u),
        sp.size * fade * max(u, .5),
        Paint()..color = Colors.white.withValues(alpha: fade),
      );
    }

    if (s.sleeping) {
      for (var i = 0; i < 3; i++) {
        final ph = (s.t * .45 + i / 3) % 1;
        final tp = TextPainter(
          text: TextSpan(
            text: 'z',
            style: TextStyle(color: color.withValues(alpha: sin(pi * ph)), fontSize: compact ? 7 + 6 * ph : 14 + 10 * ph, fontWeight: FontWeight.bold),
          ),
          textDirection: TextDirection.ltr,
        )..layout();
        tp.paint(
          canvas,
          compact
              ? Offset(size.width / 2 + w * 1.6 + ph * 8, size.height * .5 - ph * size.height * .45)
              : Offset(size.width * .72 + ph * 24, size.height * .55 - ph * size.height * .4),
        );
      }
    }
    canvas.restore();
  }
}
