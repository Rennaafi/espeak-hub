// Builds ESPeak_Hub_HardwareX_Report.docx (HardwareX article template layout: US Letter, Calibri 11).
//   NODE_PATH=<dir with node_modules/docx> node build_report.js
const fs = require("fs");
const path = require("path");
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, ImageRun, AlignmentType, BorderStyle,
  WidthType, ShadingType, LevelFormat, HeadingLevel,
} = require("docx");

const HERE = __dirname;
const FULL = 9360; // content width, DXA (US Letter, 1" margins)

// ---- text helpers: **bold**, ^[superscript] ----
function runs(text, base = {}) {
  const out = [];
  const re = /(\*\*[^*]+\*\*|\^\[[^\]]+\])/g;
  for (const part of text.split(re)) {
    if (!part) continue;
    if (part.startsWith("**")) out.push(new TextRun({ ...base, text: part.slice(2, -2), bold: true }));
    else if (part.startsWith("^[")) out.push(new TextRun({ ...base, text: part.slice(2, -1), superScript: true }));
    else out.push(new TextRun({ ...base, text: part }));
  }
  return out;
}
const P = (text, o = {}) => new Paragraph({
  children: runs(text, o.run || {}), spacing: { after: o.after ?? 120, before: o.before ?? 0, line: 264 },
  alignment: o.align || AlignmentType.JUSTIFIED, keepNext: o.keepNext, indent: o.indent,
});
const H1 = (text) => new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text, bold: true })], spacing: { before: 280, after: 120 }, keepNext: true });
const H2 = (text) => new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun({ text, bold: true })], spacing: { before: 200, after: 100 }, keepNext: true });
const H3 = (text) => new Paragraph({ heading: HeadingLevel.HEADING_3, children: [new TextRun({ text, bold: true, italics: true })], spacing: { before: 140, after: 80 }, keepNext: true });
const bullets = (items) => items.map((t) => new Paragraph({
  numbering: { reference: "bul", level: 0 }, children: runs(t), spacing: { after: 70, line: 264 }, alignment: AlignmentType.LEFT,
}));
const steps = (items, ref) => items.map((t) => new Paragraph({
  numbering: { reference: ref, level: 0 }, children: runs(t), spacing: { after: 70, line: 264 }, alignment: AlignmentType.LEFT,
}));
const caption = (t, o = {}) => new Paragraph({ children: runs(t, { size: 19, italics: false }), spacing: { before: o.before ?? 60, after: o.after ?? 200 }, alignment: AlignmentType.LEFT, keepNext: o.keepNext });
const tcap = (t) => caption(t, { before: 160, after: 60, keepNext: true });

// ---- tables ----
const line = { style: BorderStyle.SINGLE, size: 4, color: "999999" };
const borders = { top: line, bottom: line, left: line, right: line };
function table(rows, widths, o = {}) {
  const sz = o.size || 19;
  return new Table({
    width: { size: widths.reduce((a, b) => a + b, 0), type: WidthType.DXA }, columnWidths: widths,
    rows: rows.map((r, ri) => new TableRow({
      tableHeader: ri === 0 && o.header !== false, cantSplit: true,
      children: r.map((c, ci) => {
        const head = ri === 0 && o.header !== false;
        const lead = o.leadBold && ci === 0;
        return new TableCell({
          width: { size: widths[ci], type: WidthType.DXA }, borders,
          shading: head || lead ? { fill: "EDEDED", type: ShadingType.CLEAR, color: "auto" } : undefined,
          margins: { top: 50, bottom: 50, left: 90, right: 90 },
          children: String(c).split("\n").map((ln) => new Paragraph({
            children: runs(ln, { size: sz, bold: head || lead }), spacing: { after: 0, line: 240 },
            alignment: o.align && o.align[ci] === "r" ? AlignmentType.RIGHT : AlignmentType.LEFT,
          })),
        });
      }),
    })),
  });
}
const gap = () => new Paragraph({ children: [], spacing: { after: 80 } });

// ---- images (PNG, width in inches) ----
function fig(file, wIn, caption_) {
  const buf = fs.readFileSync(path.join(HERE, "img", file));
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20); // PNG IHDR
  const px = wIn * 96;
  return [
    new Paragraph({ alignment: AlignmentType.CENTER, keepNext: true, spacing: { before: 120, after: 40 },
      children: [new ImageRun({ type: "png", data: buf, transformation: { width: px, height: px * h / w }, altText: { title: file, description: caption_, name: file } })] }),
    caption(caption_),
  ];
}

// ================= content =================
const body = [];
const add = (...x) => x.flat().forEach((e) => body.push(e));

add(new Paragraph({ children: [new TextRun({ text: "ESPeak Hub: An Open-Source ESP32-S3 Voice Assistant Peripheral with Cloud-Hosted LLM Processing", bold: true, size: 36 })], spacing: { after: 160 } }));
add(P("**Authors:** Muhammad Refansa A.*", { align: AlignmentType.LEFT, after: 60 }));
add(P("**Affiliations:** [add affiliation]", { align: AlignmentType.LEFT, after: 60 }));
add(P("**Contact email:** Muhammad.refans01@gmail.com", { align: AlignmentType.LEFT, after: 160 }));

add(H1("Abstract"));
add(P("Commercial voice assistants such as Amazon Echo and Google Home rely on closed, cloud-hosted platforms that users cannot inspect, modify, or extend. This article presents ESPeak Hub, an open-source, low-cost (about US$15) voice assistant peripheral built around an ESP32-S3 microcontroller. A smartphone app records the spoken command and sends it to a serverless Cloudflare Worker, which orchestrates speech-to-text, LLM response generation, and text-to-speech through Groq’s inference API, then pushes the reply audio over a persistent WebSocket to the ESP32-S3. The device plays it through an I2S amplifier and speaker while an OLED shows an animated face that reflects the assistant’s state and mood. We characterize the system in two parts. End-to-end latency over 20 turns has a median of 1.8–2.1 s, dominated by speech synthesis. A controlled FreeRTOS study (600 runs, five firmware variants) shows that streaming playback through a StreamBuffer with a 250 ms prebuffer makes time to first sound independent of reply length (about 145 ms instead of up to 4.4 s), and that blocking the Arduino loop task and writing I2S in blocks cut core-1 load from 93% to 15%. Audio starvation followed Wi-Fi throughput rather than firmware."));
add(P("**Keywords:** ESP32-S3; FreeRTOS; voice assistant; large language model; audio streaming; real-time performance", { align: AlignmentType.LEFT }));

add(H1("Specifications table"));
add(table([
  ["Hardware name", "ESPeak Hub"],
  ["Subject area", "Educational tools and open source alternatives to existing infrastructure"],
  ["Hardware type", "Electrical engineering and computer science"],
  ["Closest commercial analog", "Amazon Echo / Google Home smart speakers. No open-source hardware analog with cloud-routed LLM processing and a modular peripheral hub is currently available."],
  ["Open source license", "MIT License"],
  ["Cost of hardware", "Rp248.900 (approx. US$15) for the core prototype; cost will increase as additional peripherals are added"],
  ["Source file repository", "[DOI URL of OSF / Mendeley Data / Zenodo repository to be added]"],
], [2600, 6760], { header: false, leadBold: true, size: 20 }));

// ---- 1 ----
add(H1("1. Hardware in context"));
add(P("Voice-controlled assistants have become a common consumer interface, led by proprietary products such as Amazon Echo and Google Home. These devices are inexpensive to purchase but are closed systems: their firmware, cloud processing pipeline, and AI models cannot be inspected, modified, or self-hosted by the end user. In the open-source space, projects such as Mycroft [6] and Rhasspy [7] provide more transparent alternatives, but most either require a comparatively powerful single-board computer (e.g., a Raspberry Pi) to run locally, or depend on a fixed set of predefined voice commands rather than free-form conversational responses from a large language model (LLM)."));
add(P("ESPeak Hub addresses this gap by keeping the physical hardware layer intentionally minimal and inexpensive (an ESP32-S3 microcontroller, a Class-D audio amplifier, a small speaker and an OLED) while delegating all computationally expensive work (speech recognition, language understanding, and speech synthesis) to cloud APIs reached through a lightweight serverless backend. This mirrors the architecture of commercial assistants but keeps every layer of the stack (firmware, backend orchestration, and companion app) open and modifiable. Because the AI backend is decoupled from the hardware, the underlying LLM or speech provider can be swapped without any hardware redesign, which is not possible with closed commercial devices."));

// ---- 2 ----
add(H1("2. Hardware description"));
add(P("ESPeak Hub is composed of three cooperating layers (Fig. 1). First, a smartphone companion app (Flutter) records the user’s spoken command and sends it to the backend. Second, a Cloudflare Worker orchestrates the pipeline: Groq’s Whisper endpoint transcribes the audio, a Groq-hosted LLM (gpt-oss-20b) writes a short reply and a mood label, and a text-to-speech engine (Groq Orpheus for English, Workers AI MeloTTS for Korean) synthesizes the voice. Third, the ESP32-S3 unit keeps a persistent WebSocket open to a Cloudflare Durable Object, which relays the reply audio to it directly instead of routing it back through the phone. The ESP32-S3 plays the audio through a MAX98357A I2S amplifier and a 3 W speaker, and draws an animated face on a 0.96\" SSD1306 OLED whose expression follows the system state (idle, listening, thinking) and the mood chosen by the LLM."));
add(...fig("system.png", 6.2, "**Fig. 1.** System overview. Steps: (1) the phone uploads the recording; (2) speech to text; (3) text to reply and mood; (4) reply to voice; (5) the Worker hands the audio to the Durable Object; (6) the Durable Object pushes 8 KB PCM frames down the open WebSocket, which the ESP32-S3 opened outward."));

add(H2("Firmware architecture and RTOS task configuration"));
add(P("The firmware is built on FreeRTOS as shipped with the Arduino-ESP32 core (ESP-IDF 4.4, 1 kHz tick) and is split into concurrent tasks so that the WebSocket, audio output and display never block one another (Table 1). Audio has the highest priority because a late status update is unnoticeable while an audible dropout is not. The priority split and core assignment were examined experimentally in Section 6.2."));
add(tcap("**Table 1.** Tasks of the as-built firmware (variant V4)."));
add(table([
  ["Task", "Core", "Priority", "Role"],
  ["loopTask (Arduino)", "1", "1", "WebSocket receive and reply framing; blocks one tick per pass"],
  ["audioTask", "1", "3", "Reads PCM from a 1 MB StreamBuffer (PSRAM), writes 256-sample blocks to I2S, enables the amplifier"],
  ["faceTask", "0", "1", "Eye animation, 128×64 OLED over I2C, 30 fps target"],
  ["onDmaTransferComplete (I2S library, hidden)", "any", "2", "Copies a 1 KB ring buffer into two 128-frame DMA buffers (about 21 ms)"],
], [2900, 800, 900, 4760], { size: 19 }));
add(gap());
add(H2("Changes from the proposal"));
add(...bullets([
  "A Cloudflare **Durable Object** now holds the ESP32’s WebSocket, because a stateless Worker cannot keep a socket open between requests.",
  "Text to speech uses **Groq Orpheus** (English) and **Workers AI MeloTTS** (Korean) instead of the unofficial Edge TTS library.",
  "Reply audio is **streamed** into a StreamBuffer rather than copied whole into memory before playback (the original design, V0 in Section 6.2).",
  "The WebSocket is served by the Arduino loop task on core 1, not a separate network task on core 0.",
  "The OLED shows an animated face that follows state and an LLM-chosen mood; the app offers English, a mixed English/Korean “buddy” mode, and Korean.",
]));
add(H2("Advantages over existing approaches"));
add(...bullets([
  "Low hardware cost (under Rp250,000 / about US$15) compared with single-board-computer-based open voice assistants.",
  "Free-form conversational responses from an LLM instead of a fixed command grammar.",
  "A cloud backend that is open source and swappable, avoiding lock-in to one AI provider.",
  "A modular hub that can absorb more sensors or outputs without redesigning the voice pipeline.",
  "A staged, reproducible build suitable for students and hobbyists.",
]));

add(H2("Design files"));
add(P("The design files are the ESP32 firmware, the Cloudflare Worker backend, the Flutter companion app, the benchmark and analysis scripts, and the circuit schematic. All are released under the MIT License and will be placed in an open repository before submission."));
add(tcap("**Table 2.** Design files summary."));
add(table([
  ["Design file name", "File type", "Open source license", "Location of the file"],
  ["ESP32 firmware (ESPeak Hub)", "Arduino / C++ (PlatformIO)", "MIT License", "[GitHub repository link]"],
  ["Cloudflare Worker backend", "JavaScript source code", "MIT License", "[GitHub repository link]"],
  ["ESPeak Hub companion app", "Flutter / Dart source code", "MIT License", "[GitHub repository link]"],
  ["Benchmark and analysis scripts", "Python, Typst", "MIT License", "[GitHub repository link]"],
  ["Circuit schematic", "Schematic diagram (PDF/PNG)", "MIT License", "Available with the article"],
], [2700, 2500, 1700, 2460], { size: 19 }));
add(gap());
add(...bullets([
  "**ESP32 firmware:** the FreeRTOS firmware for the ESP32-S3 (Wi-Fi, WebSocket client, I2S audio, OLED face). Build variants V0–V4 are selected with compile flags.",
  "**Cloudflare Worker backend:** the /chat route that runs speech to text, LLM and text to speech, the Durable Object that holds the speaker socket, and the /bench test route.",
  "**Companion app:** the Flutter app with hold-to-talk, chat history, phone/speaker switch and language modes.",
  "**Benchmark and analysis scripts:** the test driver, statistics and figure code used in Section 6.2, with the raw data.",
  "**Circuit schematic:** wiring of the ESP32-S3, MAX98357A amplifier, speaker and OLED (Table 4).",
]));

// ---- 3 BOM ----
add(H1("3. Bill of materials"));
add(P("The bill of materials covers the core prototype needed to reproduce the ESP32 unit (audio output and status display). Costs are in Indonesian Rupiah (Rp) from local retailers at the time of writing."));
add(tcap("**Table 3.** Bill of materials."));
add(table([
  ["Designator", "Component", "Number", "Cost per unit", "Total cost", "Source of materials", "Material type"],
  ["U1", "ESP32-S3 DevKit (N8R8/N16R8, WROOM, PSRAM, Type-C)", "1", "Rp120.000", "Rp120.000", "https://tk.tokopedia.com/ZSqERDBpS/", "Semi-conductor"],
  ["U2", "I2S amplifier module (MAX98357A, Class D, 3 W)", "1", "Rp39.900", "Rp39.900", "https://tk.tokopedia.com/ZSqERmsAk/", "Semi-conductor"],
  ["SPK1", "Speaker (3 W, 8 Ω, with cable)", "1", "Rp26.000", "Rp26.000", "https://tk.tokopedia.com/ZSqERbYK8/", "Non-specific"],
  ["CBL1", "Jumper cable, male-male (Dupont, 20 cm)", "20", "Rp550", "Rp11.000", "https://tk.tokopedia.com/ZSqERKUHK/", "Metal"],
  ["OLED1", "OLED display (0.96\" I2C, 128×64, yellow/blue)", "1", "Rp36.500", "Rp36.500", "https://tk.tokopedia.com/ZSqERoSqf/", "Semi-conductor"],
  ["BB1", "Breadboard, solderless (400 points)", "1", "Rp15.500", "Rp15.500", "https://tk.tokopedia.com/ZSqERVRKC/", "Polymer"],
  ["", "**Total**", "", "", "**Rp248.900**", "", ""],
], [850, 2300, 750, 1050, 1050, 2100, 1260], { size: 16 }));
add(gap());

// ---- 4 build ----
add(H1("4. Build instructions"));
add(P("The system is built in incremental stages so each layer can be tested before integration."));
add(...steps([
  "**Backend core.** Deploy a Cloudflare Worker that accepts input and forwards it to the Groq LLM API. Set the secrets GROQ_API_KEY and APP_KEY with wrangler. Verify with an HTTP client before any hardware is involved.",
  "**Speech to text.** Record audio in the Flutter app and send it (multipart audio plus a JSON meta field, with the X-App-Key header) to the Worker, which calls Groq Whisper. Check that spoken input is transcribed.",
  "**Full software pipeline.** Chain transcription, LLM reply and text to speech, and return the synthesized WAV to the phone. At this stage the assistant works as a phone-only application. The Worker reports each stage’s duration in X-Ms-* response headers.",
  "**ESP32 bring-up.** Wire the amplifier U2, speaker SPK1 and OLED1 to the ESP32-S3 U1 as in Table 4 using CBL1 and BB1. Flash the firmware (PlatformIO environment speaker, Wi-Fi credentials in a gitignored secrets.h). Confirm the OLED face appears and a test tone plays.",
  "**Integration.** Enable the Durable Object route so that the Worker pushes the reply (a JSON audio header followed by 8 KB PCM frames) down the ESP32’s WebSocket when the app’s target switch is set to speaker.",
], "num1"));
add(tcap("**Table 4.** ESP32-S3 wiring."));
add(table([
  ["Signal", "ESP32-S3 pin", "Connected to"],
  ["I2S bit clock", "GPIO5", "MAX98357A BCLK"],
  ["I2S word select", "GPIO6", "MAX98357A LRC"],
  ["I2S data out", "GPIO7", "MAX98357A DIN"],
  ["Amplifier shutdown", "GPIO15", "MAX98357A SD (low = muted, high only while a reply plays)"],
  ["I2C data", "GPIO14", "SSD1306 SDA (address 0x3C)"],
  ["I2C clock", "GPIO13", "SSD1306 SCL"],
  ["Power", "5 V, GND", "MAX98357A VIN, GND; OLED 3.3 V"],
], [2300, 2000, 5060], { size: 19 }));
add(gap());
add(P("**Design notes.** The amplifier’s SD pin is held low except during playback and the I2S driver is primed with 0.5 s of silence, which removed the boot and idle noise. The ESP32-S3 variant with 8 MB PSRAM is needed because the 1 MB stream buffer lives in PSRAM. The speaker is rated 3 W and the amplifier delivers at most about 1.8 W at 5 V / 8 Ω, leaving headroom."));
add(P("**Safety.** The amplifier and speaker run at low voltage (3.3 V / 5 V, 3 W audio) and present no significant electrical hazard. Take standard precautions when soldering and handling exposed breadboard connections."));

// ---- 5 operation ----
add(H1("5. Operation instructions"));
add(...steps([
  "Power the ESP32-S3 unit over USB-C. The OLED shows eyes opening, and a “no wifi” notice only if the network is missing; once Wi-Fi and the WebSocket are up the face is idle.",
  "Open the companion app, pick **Speaker** in the phone/speaker switch and a language mode (English, buddy, or Korean).",
  "Press and hold the talk bar and speak. The unit’s eyes widen while you talk and look around while the reply is being prepared.",
  "Release. The reply plays on the speaker and the face shows the mood of the answer (happy, tired, angry, confused or laughing) for about three seconds, then returns to idle. After two minutes without activity the eyes close to save the display.",
  "If nothing plays, check the phone’s internet connection and the Worker; the app shows a red “Speaker is offline” bubble with a retry tap when the device’s socket is not connected.",
], "num2"));

// ---- 6 validation ----
add(H1("6. Validation and characterization"));
add(P("Two aspects are characterized: the end-to-end latency of the voice pipeline (Section 6.1), and a controlled study of the firmware’s FreeRTOS task flow on the device (Section 6.2). The use case demonstrated is hands-free voice queries: a spoken question is answered aloud by the ESP32 unit without touching a screen. Section 6.3 lists the capabilities and limitations."));

add(H2("6.1 End-to-end pipeline latency"));
add(P("The Worker times each stage (speech to text, LLM, text to speech). Two sets of 20 turns were run. Run A used the companion app on an Android emulator on 2026-10-08 with real spoken questions (100% success). Run B used a script that sent fixed recorded clips with known text to the English Groq pipeline on 2026-10-11 (20/20 successful; 16/20 perfect transcripts, mean word error rate 0.049). Both measure the cloud stages and the round trip to the phone or script, not playback on the ESP32."));
add(tcap("**Table 5.** Stage time in ms over 20 turns, median [IQR] and 95th percentile."));
add(table([
  ["Stage", "Run A (app): median [IQR]", "Run A: p95", "Run B (script): median [IQR]", "Run B: p95"],
  ["Speech to text", "238 [226, 269]", "598", "233 [226, 249]", "272"],
  ["LLM", "487 [335, 564]", "665", "477 [419, 489]", "525"],
  ["Text to speech", "1149 [695, 1799]", "2503", "1013 [855, 1358]", "1756"],
  ["Total (request to full reply)", "2074 [1409, 2601]", "4141", "1775 [1492, 2074]", "2564"],
], [2400, 2200, 1100, 2500, 1160], { size: 19, align: ["l", "l", "r", "l", "r"] }));
add(gap());
add(P("Text to speech is the largest stage: it takes a median 60% of the total in Run A, and its duration grows with reply length (about 159 ms plus 11.3 ms per character, r = 0.93). Run A’s p95 total is inflated by a single 5.5 s speech-to-text spike, which also explains why its mean speech-to-text time (498 ms) is twice its median. The measured medians of 1.8–2.1 s are for the cloud path only; Section 6.2 characterizes what the device adds."));
add(P("Observed quality issues: the LLM stated some Formula 1 facts incorrectly, markdown markers occasionally leaked into the spoken text, and automatic language detection once classified an English question as Icelandic, so the Worker now fixes the speech-recognition language to English except in Korean mode."));

add(H2("6.2 Evaluation of the FreeRTOS task flow"));
add(H3("6.2.1 Question"));
add(P("The speaker receives each reply as 16-bit, 24 kHz mono PCM over a WebSocket and plays it over I2S while the OLED face animates. The original firmware (V0) copies the whole reply into PSRAM before the audio task starts. We ask whether this task flow is optimal for the user-visible metric, **time to first sound (TTFS)**, under the hard constraint of **no audio starvation**, and what it costs in CPU load, face smoothness, stack and heap."));
add(H3("6.2.2 Variants"));
add(P("Static inspection of the firmware showed two properties that shape the study: (i) the Arduino loopTask never blocks, so core 1’s idle task never runs and core 1 reads 100% busy whatever the audio task does; a task like this placed above the audio task would starve it completely; (ii) the I2S library takes a mutex and performs one ring-buffer send per sample, i.e. 48,000 kernel calls per second. All variants are one source file selected by compile flags (Table 6)."));
add(tcap("**Table 6.** Firmware variants (each adds to the previous, except V3)."));
add(table([
  ["Variant", "Change", "Hypothesis"],
  ["V0", "Baseline: buffer the whole reply in PSRAM, then notify the audio task", "TTFS grows linearly with reply length"],
  ["V1", "StreamBuffer (1 MB, PSRAM): loop task produces, audio task starts after P ms are buffered", "TTFS becomes independent of length"],
  ["V2", "V1 + loop() blocks one tick per pass; face task periodic (vTaskDelayUntil, 33 ms)", "Removes busy polling, frees core 1"],
  ["V3", "V2 + network task priority 4 (above audio)", "Faster download, risk to audio"],
  ["V4", "V2 + 256-sample block writes (I2S.write_blocking) instead of per-sample writes", "Lower I2S kernel overhead"],
], [900, 5400, 3060], { size: 19 }));
add(gap());
add(H3("6.2.3 Method"));
add(P("**Stimulus.** A /bench route on the Worker pushes a fixed WAV through the same Durable Object and WebSocket path as a real reply, skipping speech recognition, LLM and text to speech, so only the device and network are measured. Three clips (Orpheus voice, 24 kHz mono): short 2.08 s (100 kB), medium 4.00 s (192 kB), long 13.36 s (641 kB)."));
add(P("**Instrumentation** (compiled in with a BENCH flag). No oscilloscope or logic analyzer was available, so all timing is software, with esp_timer microsecond resolution. TTFS is the time from the audio header being received to the first sample being handed to the I2S driver (it includes a 30 ms amplifier wake-up). Starvation means the audio task found the stream buffer empty mid-reply; dry events mean the I2S library’s ring buffer was found empty. FreeRTOS run-time statistics are compiled out of the precompiled Arduino core, so per-core load is measured with an idle hook on each core that counts CPU cycles spent in the idle task; “playback load” is the load during playback only. Face frames drawn, the longest gap between frames, stack high-water marks, heap and RSSI were also logged."));
add(P("**Design.** 20 repetitions per clip per condition in a shuffled order with a fixed seed. V1 swept P ∈ {0, 50, 100, 250, 500} ms (300 runs); V2–V4 ran at the selected P*. Medians with IQR are reported; groups are compared with the two-sided Mann–Whitney U test and a 10,000-resample bootstrap 95% CI of the median difference; proportions with Fisher’s exact test. Runs cut off by a Wi-Fi disconnect (5 of 600) are excluded from timing statistics."));
add(P("**Selection of the prebuffer.** The rule fixed before the sweep was the smallest P with zero starvation and zero dry events. Deviation: no P met it, because dry events occurred at every P and do not depend on P; the rule was amended after the sweep to zero starvation only, giving P* = 250 ms."));

add(H3("6.2.4 Results"));
add(P("**Streaming removes the length-dependent wait (Fig. 2).** V0’s TTFS grows by 7.47 ms per kB of reply (r = 0.945); V1’s does not depend on length (−0.01 ms/kB, r = −0.05). Every one of the 20 V1 runs per clip started faster than the fastest V0 run (U = 400)."));
add(tcap("**Table 7.** Median time to first sound, V0 against V1 at P = 250 ms."));
add(table([
  ["Clip", "V0 TTFS", "V1 TTFS", "Difference [95% CI]", "p (Mann–Whitney)"],
  ["Short (2.1 s)", "669 ms", "143 ms", "527 ms [487, 561]", "6.8 × 10^[-8]"],
  ["Medium (4.0 s)", "1307 ms", "147 ms", "1160 ms [1117, 1315]", "6.8 × 10^[-8]"],
  ["Long (13.4 s)", "4403 ms", "142 ms", "4261 ms [4222, 4357]", "6.8 × 10^[-8]"],
], [1900, 1500, 1500, 2600, 1860], { size: 19 }));
add(gap());
add(...fig("fig1_ttfs_v0_v1.png", 3.9, "**Fig. 2.** Time to first sound by reply length: V0 (buffer whole reply) and V1 (stream, P = 250 ms). Dots are runs, bars are medians."));
add(P("Placed after the measured cloud stages (Run B medians), the end-of-speech-to-first-sound time for a medium reply drops from about 3.0 s to 1.9 s (Fig. 5; device and cloud were measured on different clocks and are shown side by side)."));

add(P("**Prebuffer size (Fig. 3).** The Worker sends 8,192-byte frames (170.7 ms of audio), so every P ≤ 170 ms starts on the first frame (TTFS ≈ 31 ms) and P = 250 or 500 ms waits for the second (≈ 145 ms)."));
add(tcap("**Table 8.** Prebuffer sweep, V1, all clips pooled."));
add(table([
  ["P (ms)", "Runs starved", "Starvation events", "Longest gap", "Dry events", "TTFS median"],
  ["0", "1/59", "4", "187 ms", "3", "30.8 ms"],
  ["50", "5/60", "7", "536 ms", "3", "31.1 ms"],
  ["100", "3/58", "5", "145 ms", "2", "30.9 ms"],
  ["**250**", "**0/60**", "0", "n/a", "1", "145.3 ms"],
  ["500", "1/59", "8", "652 ms", "1", "145.5 ms"],
], [1100, 1500, 1800, 1500, 1360, 2100], { size: 19, align: ["l", "l", "l", "l", "l", "l"] }));
add(gap());
add(...fig("fig2_prebuffer_sweep.png", 6.4, "**Fig. 3.** Prebuffer sweep: (a) TTFS against P, median and IQR; (b) runs with at least one starvation event, out of 20."));
add(P("Pooled, starting on the first frame starved 9/177 runs (5.1%) against 1/119 (0.8%) when waiting for the second (Fisher p = 0.054): a trade of about 115 ms of TTFS for a roughly six-fold drop in starvation risk, suggestive but not significant at α = 0.05. 0/60 at P = 250 bounds the true per-run starvation rate below about 5% (rule of three). The single P = 500 starvation happened in a run whose download (7.4 s for 4 s of audio) was slower than real time, which no prebuffer short of the whole reply can protect against; the fluid model requires P ≥ T(1 − R/C) for a reply of duration T, playback rate R and download rate C (about 1.84 s for that run)."));

add(P("**RTOS overheads (Fig. 4).** Load during playback, median, all clips pooled at P* (V0 has no P)."));
add(tcap("**Table 9.** Load during playback, longest face-frame gap and minimum free stack by variant."));
add(table([
  ["Variant", "Core 0", "Core 1", "Longest face gap", "Stack free (min): audio / face / loop / I2S"],
  ["V0", "6.9%", "100.0%", "61.8 ms", "1788 / 6288 / 3852 / 18444 B"],
  ["V1", "11.1%", "92.8%", "63.0 ms", "1772 / 6256 / 3868 / 18452 B"],
  ["V2", "9.9%", "66.2%", "69.7 ms", "1804 / 6320 / 3884 / 18452 B"],
  ["V3", "10.4%", "69.6%", "70.1 ms", "1772 / 6320 / 3852 / 18452 B"],
  ["V4", "9.9%", "**14.5%**", "70.1 ms", "1804 / 6320 / 3900 / 18444 B"],
], [1000, 1100, 1200, 1900, 4160], { size: 19 }));
add(gap());
add(...fig("fig3_load_face.png", 6.4, "**Fig. 4.** Per-core load during playback and longest face-frame gap by variant (boxes: IQR, line: median; dashed line: 33 ms frame target)."));
add(...bullets([
  "**Busy polling (V1 to V2).** Blocking the loop task for one tick per pass cut core-1 load from 92.8% to 66.2% (−26.6 points [26.2, 27.8], p = 7 × 10^[-28]) with no measurable change in download time (p = 0.18, same network period). V0 reads exactly 100% because its idle task never runs.",
  "**Network priority (V2 to V3).** Raising the WebSocket task above the audio task cost 3.4 points of core-1 load (p = 3 × 10^[-24]) for at most a marginal download gain (−128 ms median, 95% CI [11, 463] ms, p = 0.055). Its 2/46 starved runs (V2: 0/60, Fisher p = 0.19) both came at the start of a session whose link ran at 24 kB/s, slower than real time. The bottleneck is the radio link, not the CPU, so priority has little to win.",
  "**Per-sample I2S writes (V2 to V4).** Writing 256-sample blocks cut core-1 playback load from 66.2% to 14.5% (−51.7 points [51.5, 51.8], p = 7 × 10^[-28]): about 78% of the remaining core-1 work was kernel overhead from one mutex plus ring-buffer send per sample. V4 could only be run after a hotspot outage, on a slower link (about 100 kB/s instead of 150 kB/s), so V2 was re-run as a control in the same period: core-1 load 66.2 against 14.5% (p = 3 × 10^[-21]), download time 1743 against 1983 ms (p = 0.28), starved runs 5/60 against 5/60 (Fisher p = 1). Block writes cut CPU cost and change neither download nor starvation.",
  "**Face.** No variant meets the 33 ms frame target: the longest frame gap is 62–70 ms in all of them, and V2’s periodic face task is about 6.7 ms worse than V1’s free-running one (p = 9 × 10^[-28]). The face task runs alone on core 0 at about 10% load, so the likely cause is the frame itself: pushing a full 1 KB frame over I2C at 400 kHz takes at least 23 ms (an estimate; the transfer time was not measured separately).",
  "**Memory.** The audio task never had less than 1772 B of its 4096 B stack free (43% headroom); no variant changed heap or stack use meaningfully. The 1 MB stream buffer lives in PSRAM (7.3 MB free).",
]));
add(P("**Reliability.** 5 of 600 replies were cut off by a Wi-Fi disconnect (V1: 4, V3: 1, all long clips) and are excluded above. One session was interrupted when the phone hotspot lost its uplink; afterwards the link was slower (91–115 kB/s per session against 136–157 kB/s before). Starvation follows the network, not the firmware: starved runs downloaded at a median 68 kB/s against 148 kB/s for the rest (Mann–Whitney p = 5 × 10^[-14]), and the identical V2 firmware starved 0/60 runs before the outage and 5/60 after it. A 250 ms prebuffer covers normal jitter at about 150 kB/s (three times real time) but not at about 100 kB/s; P should be raised, or made adaptive to measured throughput, if the speaker is to run on weaker links."));
add(...fig("fig4_latency_breakdown.png", 3.9, "**Fig. 5.** Where the waiting goes for a medium reply: cloud stages (medians, Run B) plus device download and start, for V0 and V1 (P = 250 ms)."));

add(H3("6.2.5 Threats to validity"));
add(...bullets([
  "**Software timestamps only.** “First sound” is when the sample enters the I2S driver; the roughly 21 ms of ring and DMA buffering after it is the same for every variant.",
  "**Starvation is a buffer-level proxy** for an audible gap; the I2S buffering hides very short gaps, so the proxy is conservative.",
  "**Network drift.** Measurements ran over a phone hotspot whose throughput changed between sessions. CPU load is unaffected (V3’s core-1 load was 69.6% in both its sessions), but download time and starvation are not, so those are compared only within the same network period.",
  "**Idle-hook load method** keeps the idle task spinning (no WAITI); it is valid for timing but not for power.",
  "**Fixed clips through a test route** skip the cloud stages; real end-to-end latency adds speech to text, LLM and text to speech (Section 6.1).",
  "**One board, one room.** RSSI was −34 to −40 dBm throughout and correlated only weakly with download time (Spearman ρ = −0.12).",
]));
add(H3("6.2.6 Conclusion of the study"));
add(P("The original flow is not optimal. Streaming through a FreeRTOS StreamBuffer with a 250 ms prebuffer makes the time to first sound constant at about 145 ms instead of growing with the reply (up to 4.4 s for a 13 s reply), and did not starve in 60 runs. Two further RTOS-level fixes free most of core 1: making the Arduino loop task block instead of busy-polling (−27 points), and replacing per-sample I2S writes with block writes (another −52 points). Raising the network task above the audio task costs CPU for at most a marginal download gain, so it is not worth it. Audio starvation is set by the Wi-Fi link, so the prebuffer must be sized for the slowest link the speaker must support. The recommended default is **V4** (streaming, P = 250 ms, blocking loop, block I2S writes). V4 measured a median TTFS of 169 ms because it ran on the slower link."));

add(H2("6.3 Capabilities and limitations"));
add(...bullets([
  "**Capability:** about 145 ms from the first received audio frame to sound, independent of reply length, with a 1 MB stream buffer that holds replies of more than 20 s.",
  "**Capability:** the playback path uses about 15% of core 1 and about 10% of core 0 in V4, leaving room for further peripherals.",
  "**Capability:** three language modes (English, English/Korean buddy, Korean) and a chat history of the last six turns per conversation.",
  "**Limitation:** no offline fallback; every turn needs an internet connection and free-tier API quotas that can rate-limit under heavy use.",
  "**Limitation:** cloud latency of 1.8–2.1 s (median) before the first frame is sent, dominated by text to speech.",
  "**Limitation:** audio dropouts occur when the Wi-Fi link falls to or below real-time speed (about 48 kB/s); the fixed 250 ms prebuffer does not adapt.",
  "**Limitation:** the OLED face does not reach its 30 fps target (62–70 ms longest gap), and the LLM can state facts incorrectly.",
  "**Not yet done:** a live check of V0 against V4 with about 20 real app turns, and making V4 the default firmware environment.",
]));

// ---- end matter ----
add(H1("Ethics statements"));
add(P("This project does not involve human subjects research or animal experiments in the formal research sense; all testing was conducted by the author on their own devices and does not require informed consent procedures."));
add(H1("CRediT author statement"));
add(P("Muhammad Refansa A.: Conceptualization, Methodology, Software, Hardware, Investigation, Formal analysis, Writing – Original draft, Writing – Review & Editing."));
add(H1("Acknowledgements"));
add(P("[Add acknowledgements and funding sources, or state that there were none.]"));
add(H1("Declaration of interest"));
add(P("[Confirm before submission: The author declares that there are no known competing financial interests or personal relationships that could have appeared to influence the work reported in this article.]"));
add(H1("References"));
const refs = [
  "[1] Espressif Systems, 2024. ESP32-S3 Series Datasheet. https://www.espressif.com/en/products/socs/esp32-s3 [Accessed 2026].",
  "[2] Maxim Integrated, 2017. MAX98357A/MAX98357B 3.2W, Filterless, Class D Mono Audio Amplifiers with Integrated I2S Decoder. Datasheet. Analog Devices.",
  "[3] Groq Inc., 2025. GroqCloud API Documentation. https://console.groq.com/docs [Accessed 2026].",
  "[4] Cloudflare Inc., 2025. Cloudflare Workers and Durable Objects Documentation. https://developers.cloudflare.com/workers/ [Accessed 2026].",
  "[5] Radford, A., Kim, J.W., Xu, T., Brockman, G., McLeavey, C. and Sutskever, I., 2022. Robust Speech Recognition via Large-Scale Weak Supervision (Whisper). arXiv preprint arXiv:2212.04356.",
  "[6] Mycroft AI, 2023. Mycroft: An Open Source Voice Assistant. https://mycroft.ai/ [Accessed 2026].",
  "[7] Rhasspy, 2023. Rhasspy: An Open Source, Fully Offline Voice Assistant Toolkit. https://rhasspy.readthedocs.io/ [Accessed 2026].",
  "[8] MyShell AI, 2024. MeloTTS. https://github.com/myshell-ai/MeloTTS [Accessed 2026].",
  "[9] Espressif Systems, 2024. ESP-IDF Programming Guide: FreeRTOS (IDF). https://docs.espressif.com/projects/esp-idf/ [Accessed 2026].",
];
add(...refs.map((r) => new Paragraph({ children: runs(r, { size: 20 }), spacing: { after: 60 }, alignment: AlignmentType.LEFT, indent: { left: 360, hanging: 360 } })));

const doc = new Document({
  creator: "Muhammad Refansa A.", title: "ESPeak Hub: HardwareX article",
  styles: {
    default: { document: { run: { font: "Calibri", size: 22 } } },
    paragraphStyles: [
      { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true, run: { size: 28, bold: true, font: "Calibri" }, paragraph: { outlineLevel: 0 } },
      { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true, run: { size: 24, bold: true, font: "Calibri" }, paragraph: { outlineLevel: 1 } },
      { id: "Heading3", name: "Heading 3", basedOn: "Normal", next: "Normal", quickFormat: true, run: { size: 22, bold: true, italics: true, font: "Calibri" }, paragraph: { outlineLevel: 2 } },
    ],
  },
  numbering: {
    config: [
      { reference: "bul", levels: [{ level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540, hanging: 270 } } } }] },
      ...["num1", "num2"].map((reference) => ({ reference, levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540, hanging: 360 } } } }] })),
    ],
  },
  sections: [{ properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } } }, children: body }],
});
Packer.toBuffer(doc).then((b) => { fs.writeFileSync(path.join(HERE, "ESPeak_Hub_HardwareX_Report.docx"), b); console.log("ok", b.length); });
