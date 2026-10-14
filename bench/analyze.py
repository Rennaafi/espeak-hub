# Turns data/bench.csv into the report's numbers and figures.
#   python analyze.py   ->  results/summary.csv, results/stats.txt, figures/fig*.pdf (+ .png previews)
#
# Rule for the chosen prebuffer P*, fixed before the V1 sweep: smallest P whose 60 V1 runs have zero starvation
# AND zero dry-ring events. AMENDED after the sweep (reported as a deviation): no P met it, because dry events
# turned out P-independent (they come from download + playback overlapping on core 1), so P* = smallest P with
# zero starvation; dry events are reported separately. V2-V4 are measured at P*.
import pathlib
import numpy as np, pandas as pd
import matplotlib as mpl, matplotlib.pyplot as plt
from scipy import stats

ROOT = pathlib.Path(__file__).resolve().parent
RES, FIG = ROOT / "results", ROOT / "figures"
RES.mkdir(exist_ok=True); FIG.mkdir(exist_ok=True)
CLIPS = ["short", "medium", "long"]
CLIP_S = {"short": 2.08, "medium": 4.00, "long": 13.36}  # clip durations (make_clips.py output)

# ---- journal look: sans-serif 7 pt, thin axes, no top/right spines, vector text ----
mpl.rcParams.update({
    "font.family": "sans-serif", "font.sans-serif": ["Arial", "Helvetica", "DejaVu Sans"], "font.size": 7,
    "axes.labelsize": 7, "axes.titlesize": 7, "xtick.labelsize": 6.5, "ytick.labelsize": 6.5, "legend.fontsize": 6.5,
    "axes.linewidth": 0.6, "xtick.major.width": 0.6, "ytick.major.width": 0.6, "xtick.major.size": 2.5, "ytick.major.size": 2.5,
    "axes.spines.top": False, "axes.spines.right": False, "legend.frameon": False,
    "pdf.fonttype": 42, "svg.fonttype": "none", "savefig.dpi": 300, "savefig.bbox": "tight", "savefig.pad_inches": 0.02,
})
INK, MUTED, GRID = "#0b0b0b", "#52514e", "#e4e3df"
C = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4"]  # validated categorical order (blue, orange, aqua, yellow, magenta)
COL1, COL2 = 3.5, 7.2  # single / double column width, inches

def panel(ax, letter):
    ax.text(-0.16, 1.04, letter, transform=ax.transAxes, fontsize=8, fontweight="bold", va="bottom", color=INK)

def grid(ax):
    ax.yaxis.grid(True, color=GRID, lw=0.5); ax.set_axisbelow(True)

def save(fig, name):
    fig.savefig(FIG / f"{name}.pdf"); fig.savefig(FIG / f"{name}.png"); plt.close(fig)

def q(x, p): return float(np.percentile(x, p))

def boot_median_diff(a, b):  # 95% CI of median(a) - median(b)
    r = stats.bootstrap((np.asarray(a), np.asarray(b)), lambda x, y, axis=-1: np.median(x, axis=axis) - np.median(y, axis=axis),
                        n_resamples=10000, method="percentile", random_state=1)
    return r.confidence_interval.low, r.confidence_interval.high

d = pd.read_csv(ROOT / "data/bench.csv")
out = []
# a reply cut off by a WebSocket drop never got its last byte (dl_ms < 0): count it, keep it out of the timing stats
ab = d[d.dl_ms < 0]
out.append(f"Replies aborted by a WebSocket disconnect (excluded below): {len(ab)} of {len(d)} rows; by variant/clip: "
           + (", ".join(f"{v}/{c}: {n}" for (v, c), n in ab.groupby(["variant", "clip"]).size().items()) or "none"))
out.append("  (V0 reports no row for an aborted reply and the driver retries it; disconnects per session are in data/logs/*.out)")
d = d[d.dl_ms >= 0]

# ---- summary table: one row per variant x P x clip ----
rows = []
for (v, p, c), g in d.groupby(["variant", "prebuf_ms", "clip"]):
    t = g["ttfs_ms"]
    rows.append(dict(variant=v, prebuf_ms=p if v != "V0" else "", clip=c, n=len(g),
                     ttfs_median=t.median(), ttfs_iqr=q(t, 75) - q(t, 25), ttfs_p95=q(t, 95), ttfs_max=t.max(),
                     dl_median=g["dl_ms"].median(), throughput_kBps=(g["bytes"] / g["dl_ms"]).median(),
                     starves=int(g["starves"].sum()), runs_with_starve=int((g["starves"] > 0).sum()), max_gap_ms=g["max_gap_ms"].max(),
                     dry=int(g["dry"].sum()), load0_median=g["load0"].median(), load1_median=g["load1"].median(),
                     pload0_median=g["pload0"].median(), pload1_median=g["pload1"].median(),
                     face_fps=(g["frames"] / ((g["ttfs_ms"] + g["play_ms"]) / 1e3)).median(), face_max_gap_ms=g["max_frame_ms"].max(),
                     hwm_audio_min=g["hwm_audio"].min(), hwm_face_min=g["hwm_face"].min(), hwm_loop_min=g["hwm_loop"].min(),
                     hwm_i2s_min=g["hwm_i2s"].min(), heap_min=g["heap_min"].min(), rssi_median=g["rssi"].median()))
S = pd.DataFrame(rows)
S.to_csv(RES / "summary.csv", index=False, float_format="%.2f")

v1 = d[d.variant == "V1"]
pre = [p for p, g in v1.groupby("prebuf_ms") if g["starves"].sum() == 0 and g["dry"].sum() == 0]
out.append(f"Pre-registered rule (zero starvation AND zero dry): {min(pre) if pre else 'no P qualifies'}")
ok = [p for p, g in v1.groupby("prebuf_ms") if g["starves"].sum() == 0]
PSTAR = min(ok) if ok else None
out.append(f"P* (amended: smallest P with zero starvation over all V1 runs) = {PSTAR}")
if len(v1):
    out.append("\nV1 per P: runs with starvation / dry events / median TTFS")
    for p, g in v1.groupby("prebuf_ms"):
        out.append(f"  P={p:>3}: starve runs {(g.starves > 0).sum()}/{len(g)}, starve events {g.starves.sum()}, "
                   f"max gap {g.max_gap_ms.max():.0f} ms, dry {g.dry.sum()}, TTFS {g.ttfs_ms.median():.1f} ms")
    # the Worker sends 8192-byte frames = 170.7 ms of audio, so P <= 170 ms all start on the first frame
    first = v1.prebuf_ms * 48 <= 8192
    a_, b_ = v1[first], v1[~first]
    sa, sb = int((a_.starves > 0).sum()), int((b_.starves > 0).sum())
    fp = stats.fisher_exact([[sa, len(a_) - sa], [sb, len(b_) - sb]]).pvalue
    out.append(f"  start on frame 1 (P<=170): {sa}/{len(a_)} runs starved ({100 * sa / len(a_):.1f} %), TTFS {a_.ttfs_ms.median():.1f} ms; "
               f"start on frame 2+ (P>=250): {sb}/{len(b_)} ({100 * sb / len(b_):.1f} %), TTFS {b_.ttfs_ms.median():.1f} ms; Fisher exact p = {fp:.3g}")
    for p, g in v1.groupby("prebuf_ms"):
        if (g.starves > 0).sum() == 0:
            out.append(f"  P={p}: 0/{len(g)} starved -> 95 % upper bound on the per-run starvation rate ~ {300 / len(g):.1f} % (rule of three)")
    slow = d[(d.dl_ms > 0) & (d.bytes / d.dl_ms < 48)]
    out.append(f"  runs whose download was slower than real time (< 48 kB/s): {len(slow)} of {len(d)}; "
               f"no finite prebuffer short of the whole reply prevents starvation there")
out.append("\nDry-ring events (I2S library ring found empty) per variant: events / runs")
for v, g in d.groupby("variant"):
    out.append(f"  {v}: {g.dry.sum()} / {len(g)} runs ({(g.dry > 0).sum()} runs with any)")

# ---- headline test: V0 vs V1@P*, per clip ----
v0 = d[d.variant == "V0"]
if PSTAR is not None and len(v0):
    best = v1[v1.prebuf_ms == PSTAR]
    out.append("\nTTFS, V0 vs V1@P*: medians, Mann-Whitney U (two-sided), 95% bootstrap CI of the median difference (V0 - V1)")
    for c in CLIPS:
        a, b = v0[v0["clip"] == c]["ttfs_ms"], best[best["clip"] == c]["ttfs_ms"]
        if len(a) and len(b):
            u = stats.mannwhitneyu(a, b, alternative="two-sided")
            lo, hi = boot_median_diff(a, b)
            out.append(f"  {c:6}: V0 {a.median():8.1f} ms (n={len(a)})  V1 {b.median():7.1f} ms (n={len(b)})  "
                       f"diff {a.median() - b.median():8.1f} ms [{lo:.1f}, {hi:.1f}]  U={u.statistic:.0f} p={u.pvalue:.2g}")
    # does TTFS grow with reply length? slope of TTFS vs clip bytes
    for name, g in (("V0", v0), (f"V1@P={PSTAR}", best)):
        r = stats.linregress(g["bytes"] / 1e3, g["ttfs_ms"])
        out.append(f"  TTFS vs size, {name}: {r.slope:.2f} ms per kB, r = {r.rvalue:.3f}")
    r = stats.spearmanr(d["rssi"], d["dl_ms"] / d["bytes"])
    out.append(f"  RSSI vs download time per byte (all runs): Spearman rho = {r.statistic:.2f}, p = {r.pvalue:.2g}")

# ---- secondary: core load and face, each variant at P* (V0 has no P) ----
at = d[(d.variant == "V0") | (d.prebuf_ms == PSTAR)] if PSTAR is not None else d
out.append("\nLoad during playback (first -> last sample), medians [IQR], all clips pooled; (whole reply)")
for v, g in at.groupby("variant"):
    out.append(f"  {v}: core0 {g.pload0.median():5.1f} % [{q(g.pload0, 25):.1f}-{q(g.pload0, 75):.1f}] ({g.load0.median():.1f})  "
               f"core1 {g.pload1.median():5.1f} % [{q(g.pload1, 25):.1f}-{q(g.pload1, 75):.1f}] ({g.load1.median():.1f})  "
               f"face max gap {g.max_frame_ms.median():.1f} ms  starves {int(g.starves.sum())}  dry {int(g.dry.sum())}  "
               f"min stack free: audio {g.hwm_audio.min()} face {g.hwm_face.min()} loop {g.hwm_loop.min()} i2s {g.hwm_i2s.min()} B")
# the phone hotspot dropped at ~23:40 and came back on a slower link: download time and starvation depend on the
# network, so they are compared within one network period only (CPU load does not: V3 reads 69.6 % in both periods)
OUTAGE = "20261011_2340"
pre = at[at.session < OUTAGE]
for a_, b_ in (("V0", "V1"), ("V1", "V2"), ("V2", "V3"), ("V2", "V4")):
    for col in ("pload0", "pload1", "dl_ms", "max_frame_ms"):
        src = pre if col == "dl_ms" else at  # V2 vs V4 download time: see the same-network control below
        A, B = src[src.variant == a_], src[src.variant == b_]
        if len(A) and len(B):
            u = stats.mannwhitneyu(A[col], B[col], alternative="two-sided")
            lo, hi = boot_median_diff(A[col], B[col])
            out.append(f"  {a_} vs {b_} {col}: {A[col].median():.1f} vs {B[col].median():.1f}, "
                       f"diff {A[col].median() - B[col].median():+.1f} [{lo:.1f}, {hi:.1f}] p={u.pvalue:.2g}")
# ---- network drift: the hotspot's speed changed between sessions (V4 ran only after an outage, on a slower link),
# so download time / starvation between variants is compared only within the same network period ----
d["kBps"] = d.bytes / d.dl_ms
out.append("\nNetwork drift: download throughput per session (median kB/s), runs with starvation")
for (v, s), g in d.groupby(["variant", "session"]):
    out.append(f"  {v} {s}: n={len(g):3}  {g.kBps.median():6.1f} kB/s  starved runs {(g.starves > 0).sum()}")
st = d[d.starves > 0]
u = stats.mannwhitneyu(st.kBps, d[d.starves == 0].kBps, alternative="two-sided")
out.append(f"  starved runs download at {st.kBps.median():.1f} kB/s vs {d[d.starves == 0].kBps.median():.1f} kB/s for the rest (MWU p = {u.pvalue:.2g})")
A, B = d[(d.variant == "V2") & (d.session < OUTAGE)], d[(d.variant == "V3") & (d.session < OUTAGE)]
if len(A) and len(B):
    sa, sb = int((A.starves > 0).sum()), int((B.starves > 0).sum())
    out.append(f"  before the outage, V2 vs V3 starved runs: {sa}/{len(A)} vs {sb}/{len(B)}, Fisher p = "
               f"{stats.fisher_exact([[sa, len(A) - sa], [sb, len(B) - sb]]).pvalue:.2g} "
               f"(V3's starved runs downloaded at {B[B.starves > 0].kBps.median():.1f} kB/s)")
v4 = d[d.variant == "V4"]
if len(v4):  # same-network control: V2 sessions started after the first V4 session
    ctl = d[(d.variant == "V2") & (d.session > v4.session.min())]
    if len(ctl):
        out.append(f"  same-network control: V2 re-run ({ctl.session.iloc[0]}, n={len(ctl)}) vs V4 (n={len(v4)})")
        for col in ("pload1", "dl_ms", "kBps"):
            u = stats.mannwhitneyu(ctl[col], v4[col], alternative="two-sided")
            lo, hi = boot_median_diff(ctl[col], v4[col])
            out.append(f"    {col}: {ctl[col].median():.1f} vs {v4[col].median():.1f}, diff {ctl[col].median() - v4[col].median():+.1f} [{lo:.1f}, {hi:.1f}] p={u.pvalue:.2g}")
        sa, sb = int((ctl.starves > 0).sum()), int((v4.starves > 0).sum())
        out.append(f"    starved runs: {sa}/{len(ctl)} vs {sb}/{len(v4)}, Fisher p = "
                   f"{stats.fisher_exact([[sa, len(ctl) - sa], [sb, len(v4) - sb]]).pvalue:.2g}")
(RES / "stats.txt").write_text("\n".join(out) + "\n")
print("\n".join(out))

# ---- Fig. 1: TTFS by reply length, V0 vs V1@P* (single column) ----
if PSTAR is not None and len(v0):
    fig, ax = plt.subplots(figsize=(COL1, 2.3))
    rng = np.random.default_rng(0)
    for k, (name, g, col) in enumerate((("V0: buffer whole reply", v0, C[0]), (f"V1: stream, P = {PSTAR} ms", v1[v1.prebuf_ms == PSTAR], C[1]))):
        for i, c in enumerate(CLIPS):
            y = g[g["clip"] == c]["ttfs_ms"] / 1e3
            x = i + (k - 0.5) * 0.36
            ax.scatter(x + rng.uniform(-0.08, 0.08, len(y)), y, s=9, color=col, alpha=0.55, lw=0, label=name if i == 0 else None)
            ax.plot([x - 0.13, x + 0.13], [y.median()] * 2, color=INK, lw=1.2, solid_capstyle="round")
    ax.set_xticks(range(3), [f"{c}\n({CLIP_S[c]:.1f} s audio)" for c in CLIPS])
    ax.set_ylabel("Time to first sound (s)"); ax.set_ylim(bottom=0); grid(ax)
    ax.legend(loc="upper left", handletextpad=0.2, markerscale=1.4)
    save(fig, "fig1_ttfs_v0_v1")

# ---- Fig. 2: prebuffer sweep (double column): (a) TTFS vs P, (b) starvation events vs P ----
if len(v1):
    Ps = sorted(v1.prebuf_ms.unique())
    fig, (a1, a2) = plt.subplots(1, 2, figsize=(COL2, 2.3), gridspec_kw={"wspace": 0.35})
    for i, c in enumerate(CLIPS):
        g = v1[v1["clip"] == c].groupby("prebuf_ms")["ttfs_ms"]
        med, lo, hi = g.median(), g.quantile(0.25), g.quantile(0.75)
        a1.errorbar(med.index, med.values, yerr=[med - lo, hi - med], color=C[i], lw=1.5, marker="o", ms=4, capsize=2, elinewidth=0.8, label=c)
    a1.set_xlabel("Prebuffer P (ms)"); a1.set_ylabel("Time to first sound (ms)\nmedian, IQR"); a1.set_xticks(Ps); grid(a1)
    a1.legend(title="clip", title_fontsize=6.5, loc="lower right")
    if PSTAR is not None:
        a1.axvline(PSTAR, color=MUTED, lw=0.6, ls=(0, (2, 2)))
        a1.text(PSTAR, a1.get_ylim()[1], f" P* = {PSTAR} ms", color=MUTED, fontsize=6.5, va="top")
    w = 0.26  # P as evenly spaced categories: the count per P matters here, not the spacing
    for i, c in enumerate(CLIPS):
        g = v1[v1["clip"] == c].groupby("prebuf_ms")["starves"].apply(lambda s: (s > 0).sum()).reindex(Ps, fill_value=0)
        a2.bar(np.arange(len(Ps)) + (i - 1) * w, g.values, width=w * 0.9, color=C[i], label=c)
    a2.set_xlabel("Prebuffer P (ms)"); a2.set_ylabel("Runs with ≥1 starvation event\n(of 20)"); a2.set_xticks(range(len(Ps)), Ps); grid(a2)
    a2.legend(title="clip", title_fontsize=6.5, loc="upper right")
    a2.set_ylim(0, max(1, a2.get_ylim()[1]))
    a2.yaxis.set_major_locator(mpl.ticker.MaxNLocator(integer=True))
    panel(a1, "a"); panel(a2, "b")
    save(fig, "fig2_prebuffer_sweep")

# ---- Fig. 3: per-core load and face smoothness by variant (double column) ----
vs = [v for v in ["V0", "V1", "V2", "V3", "V4"] if v in set(at.variant)]
if vs:
    fig, axs = plt.subplots(1, 3, figsize=(COL2, 2.3), gridspec_kw={"wspace": 0.45})
    for ax, col, lab in ((axs[0], "pload0", "Core 0 load, playback (%)"), (axs[1], "pload1", "Core 1 load, playback (%)"), (axs[2], "max_frame_ms", "Longest face-frame gap (ms)")):
        data = [at[at.variant == v][col].values for v in vs]
        bp = ax.boxplot(data, widths=0.55, patch_artist=True, showfliers=True,
                        medianprops=dict(color=INK, lw=1.1), whiskerprops=dict(color=MUTED, lw=0.6), capprops=dict(color=MUTED, lw=0.6),
                        flierprops=dict(marker="o", ms=2, mfc=MUTED, mec="none"), boxprops=dict(lw=0.6, ec=MUTED))
        for patch in bp["boxes"]: patch.set_facecolor(C[0]); patch.set_alpha(0.75)
        ax.set_xticks(range(1, len(vs) + 1), vs); ax.set_ylabel(lab); grid(ax)
        if col != "max_frame_ms": ax.set_ylim(0, 100)
        else:
            ax.set_ylim(bottom=0)
            ax.axhline(33.3, color=MUTED, lw=0.6, ls=(0, (2, 2)))
            ax.text(len(vs) + 0.45, 33.3, "33 ms\ntarget", color=MUTED, fontsize=6, va="center")
    for ax, l in zip(axs, "abc"): panel(ax, l)
    save(fig, "fig3_load_face")

# ---- Fig. 4: where the waiting goes for a medium reply: cloud stages + device TTFS (single column) ----
cmp_path = ROOT.parent / "data/compare_2026-10-11.csv"
if cmp_path.exists() and PSTAR is not None and len(v0):
    g = pd.read_csv(cmp_path, encoding="utf-8-sig")
    g = g[(g.provider == "groq") & (g.ok == 1)]
    cloud = [("STT", g.stt.median()), ("LLM", g.llm.median()), ("TTS", g.tts.median())]
    dev = {"V0": v0[v0["clip"] == "medium"].ttfs_ms.median(), "V1": v1[(v1.prebuf_ms == PSTAR) & (v1["clip"] == "medium")].ttfs_ms.median()}
    fig, ax = plt.subplots(figsize=(COL1, 1.35))
    for y, v in enumerate(["V1", "V0"]):
        x = 0
        for i, (lab, ms) in enumerate(cloud + [("device: download + start", dev[v])]):
            ax.barh(y, ms / 1e3, left=x / 1e3, height=0.55, color=C[i], ec="white", lw=1, label=lab if y == 0 else None)
            x += ms
        ax.text(x / 1e3 + 0.04, y, f"{x / 1e3:.2f} s", va="center", fontsize=6.5, color=INK)
    ax.set_yticks([0, 1], [f"V1 (P = {PSTAR} ms)", "V0"]); ax.set_xlabel("Time from end of speech to first sound (s)")
    ax.xaxis.grid(True, color=GRID, lw=0.5); ax.set_axisbelow(True); ax.set_xlim(0, ax.get_xlim()[1] * 1.12)
    ax.legend(ncol=4, loc="lower left", bbox_to_anchor=(0, 1.02), handlelength=1, columnspacing=0.8)
    save(fig, "fig4_latency_breakdown")
print("figures ->", FIG)
