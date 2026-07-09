import { ObjectTracker } from "./tracker.js";
import { storage } from "./storage.js";

/* =========================================================================
 * StreetPulse – Hauptlogik
 * Kamera/Video -> COCO-SSD Objekterkennung -> Tracking -> Dashboard
 * Läuft komplett im Browser, keine Daten verlassen den Rechner.
 * ========================================================================= */

/* ---- 1. Kategorien: COCO-Klasse -> Anzeige ---------------------------- */
const CATEGORIES = {
  person:     { label: "Fußgänger",         singular: "Fußgänger",       emoji: "🚶", color: "#4f9dff", vehicle: false },
  car:        { label: "Autos",             singular: "Auto",            emoji: "🚗", color: "#34d399", vehicle: true  },
  truck:      { label: "LKW",               singular: "LKW",             emoji: "🚚", color: "#fbbf24", vehicle: true  },
  bus:        { label: "Busse",             singular: "Bus",             emoji: "🚌", color: "#f97316", vehicle: true  },
  bicycle:    { label: "Fahrräder",         singular: "Fahrrad",         emoji: "🚲", color: "#38bdf8", vehicle: true  },
  motorcycle: { label: "Motorräder/Roller", singular: "Motorrad/Roller", emoji: "🏍️", color: "#a78bfa", vehicle: true  },
  dog:        { label: "Hunde",             singular: "Hund",            emoji: "🐕", color: "#f472b6", vehicle: false },
  cat:        { label: "Katzen",            singular: "Katze",           emoji: "🐈", color: "#fb7185", vehicle: false },
};
const CATEGORY_KEYS = Object.keys(CATEGORIES);

/* ---- 2. Konfiguration ------------------------------------------------- */
const DETECT_INTERVAL_MS = 110;   // Mindestabstand zwischen zwei Erkennungen (~9/s)
const MAX_BOXES = 20;             // max. gleichzeitige Objekte pro Frame
const HISTORY_LENGTH = 60;        // Sekunden im Verlaufs-Diagramm
const MAX_LOG_ROWS = 400;         // im Speicher gehaltene Ereignisse (für Export)

/* ---- 3. DOM-Referenzen ------------------------------------------------ */
const $ = (id) => document.getElementById(id);
const video = $("video");
const overlay = $("overlay");
const octx = overlay.getContext("2d");
const chartCanvas = $("chart");
const cctx = chartCanvas.getContext("2d");
const dayCanvas = $("dayChart");
const dctx = dayCanvas.getContext("2d");
const speedCanvas = $("speedChart");
const spctx = speedCanvas.getContext("2d");
const weekCanvas = $("weekChart");
const wctx = weekCanvas.getContext("2d");
const els = {
  status: $("status"), btnCamera: $("btnCamera"), btnPause: $("btnPause"),
  cameraSelect: $("cameraSelect"), videoFile: $("videoFile"), btnReset: $("btnReset"),
  btnExport: $("btnExport"), confSlider: $("confSlider"), confVal: $("confVal"),
  calibSlider: $("calibSlider"), calibVal: $("calibVal"), videoHint: $("videoHint"),
  statGrid: $("statGrid"), fpsMeter: $("fpsMeter"), objMeter: $("objMeter"),
  runtimeMeter: $("runtimeMeter"), chartLegend: $("chartLegend"), log: $("log"),
  modelSelect: $("modelSelect"),
  btnZone: $("btnZone"), btnZoneClear: $("btnZoneClear"),
  btnLine: $("btnLine"), btnLineClear: $("btnLineClear"), toolHint: $("toolHint"),
  dirBar: $("dirBar"), dirA: $("dirA"), dirB: $("dirB"),
  dirAArrow: $("dirAArrow"), dirBArrow: $("dirBArrow"),
  dayLegend: $("dayLegend"), btnDayClear: $("btnDayClear"),
  alarmCats: $("alarmCats"), alarmSpeedOn: $("alarmSpeedOn"), alarmSpeedVal: $("alarmSpeedVal"),
  alarmSound: $("alarmSound"), alarmSnap: $("alarmSnap"),
  gallery: $("gallery"), galleryCount: $("galleryCount"),
  btnCalib: $("btnCalib"), btnCalibClear: $("btnCalibClear"), btnReport: $("btnReport"),
  weekLegend: $("weekLegend"), speedLimit: $("speedLimit"), spdHint: $("spdHint"),
  spdCount: $("spdCount"), spdAvg: $("spdAvg"), spdP85: $("spdP85"),
  spdMax: $("spdMax"), spdOver: $("spdOver"),
  alarmNotify: $("alarmNotify"), alarmBackground: $("alarmBackground"), notifyHint: $("notifyHint"),
  schedOn: $("schedOn"), schedFrom: $("schedFrom"), schedTo: $("schedTo"), schedStatus: $("schedStatus"),
  btnSummary: $("btnSummary"), summaryText: $("summaryText"), anomalyBadge: $("anomalyBadge"),
  btnAutoCalib: $("btnAutoCalib"), btnTheme: $("btnTheme"),
  btnCollect: $("btnCollect"), collectInterval: $("collectInterval"), collectCount: $("collectCount"),
  btnCollectZip: $("btnCollectZip"), btnCollectClear: $("btnCollectClear"),
};

/* ---- Theme (hell/dunkel) --------------------------------------------- */
let theme = storage.get("theme", "dark");
const THEME = { grid: "#2b3444", axisText: "#64748b" }; // wird aus CSS gefüllt
function applyTheme() {
  document.documentElement.setAttribute("data-theme", theme);
  const cs = getComputedStyle(document.documentElement);
  THEME.grid = cs.getPropertyValue("--chart-grid").trim() || THEME.grid;
  THEME.axisText = cs.getPropertyValue("--chart-text").trim() || THEME.axisText;
  els.btnTheme.textContent = theme === "light" ? "☀️" : "🌙";
  // Alle Canvas-Diagramme mit den neuen Farben neu zeichnen
  try { drawChart(); drawDayChart(); drawWeekChart(); drawSpeedStats(); } catch {}
  if (video.videoWidth) drawOverlay(lastTracks);
}
function toggleTheme() {
  theme = theme === "light" ? "dark" : "light";
  storage.set("theme", theme);
  applyTheme();
}

/* ---- 4. Zustand ------------------------------------------------------- */
let model = null;
let running = false;      // Loop läuft (Quelle aktiv)
let paused = false;
let source = null;        // 'camera' | 'video'
let stream = null;        // aktiver MediaStream (für sauberes Stoppen)
let lastDetectTs = 0;
let smoothedFps = 0;
// Beobachtungs-Uhr: zählt nur, während aktiv gemessen wird (Pause hält an).
let obsStart = 0;    // performance.now() beim Start der aktuellen aktiven Phase, 0 = inaktiv
let obsAccumMs = 0;  // Summe bereits abgeschlossener aktiver Phasen
let autoPaused = false; // durch Tab-Wechsel automatisch pausiert (vs. manuell)
const observationMs = () => obsAccumMs + (obsStart ? performance.now() - obsStart : 0);

const totals = Object.fromEntries(CATEGORY_KEYS.map((k) => [k, 0]));   // kumulativ
let liveCounts = Object.fromEntries(CATEGORY_KEYS.map((k) => [k, 0])); // aktuell im Bild
const history = [];      // [{person:n, car:n, ...}] pro Sekunde
const logRows = [];      // {time, secs, key, speed, dir}

// Zone & Zähllinie (normalisierte 0..1-Koordinaten -> auflösungsunabhängig)
let zone = storage.get("zone", null);   // {x, y, w, h} oder null
let line = storage.get("line", null);   // {x1, y1, x2, y2} oder null
let editMode = null;                    // null | "zone" | "line" (Zeichenmodus)
let dragStart = null, dragCurrent = null;
let lastTracks = [];                    // zuletzt gezeichnete Tracks (für Neuzeichnen)
// Richtungs-Zählung der Zähllinie
let dirTotals = { a: {}, b: {} };
// Maßstab (Kalibrierung) im Bild: nach dem Verstellen kurz hervorheben
let calibShowUntil = 0;
let calibHideTimer = null;
// 2-Punkt-Kalibrierung (präzise): {x1,y1,x2,y2 normalisiert, meters} oder null
let calib = storage.get("calib", null);

// Meter pro Bild-Pixel – aus 2-Punkt-Kalibrierung, sonst aus dem Slider.
function metersPerPixel() {
  if (!video.videoWidth) return 0;
  if (calib) {
    const distPx = Math.hypot((calib.x2 - calib.x1) * video.videoWidth,
                              (calib.y2 - calib.y1) * video.videoHeight);
    if (distPx > 4) return calib.meters / distPx;
  }
  return Number(els.calibSlider.value) / video.videoWidth;
}

/* ---- Statistik pro Tag (persistent, mehrere Tage) -------------------- */
const KEEP_DAYS = 14;             // so viele Tage aufbewahren
const MAX_SPEEDS_PER_DAY = 5000;  // Obergrenze gespeicherter Tempo-Werte/Tag

function dateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function freshDay(date) {
  return { date, hourly: Array.from({ length: 24 }, () => ({})), totals: {}, speeds: [] };
}
function loadDays() {
  let d = storage.get("days", null);
  if (!d || typeof d !== "object") {
    // Migration vom früheren Einzeltag-Format
    const old = storage.get("day", null);
    d = {};
    if (old && old.date) d[old.date] = { date: old.date, hourly: old.hourly, totals: old.totals, speeds: old.speeds || [] };
  }
  return d;
}
let days = loadDays();
let daySaveTimer = null;

// Liefert (und erstellt bei Bedarf) den Datensatz des heutigen Tages.
function currentDay() {
  const t = dateStr(new Date());
  if (!days[t] || !Array.isArray(days[t].hourly) || days[t].hourly.length !== 24) days[t] = freshDay(t);
  if (!Array.isArray(days[t].speeds)) days[t].speeds = [];
  days[t].date = t; // immer sicherstellen (auch bei migrierten Einträgen)
  return days[t];
}
function pruneDays() {
  const keys = Object.keys(days).sort();
  while (keys.length > KEEP_DAYS) delete days[keys.shift()];
}
function scheduleDaySave() {
  clearTimeout(daySaveTimer);
  daySaveTimer = setTimeout(() => { pruneDays(); storage.set("days", days); }, 1500);
}
function addToDay(key, speed) {
  const d = currentDay();
  const h = new Date().getHours();
  d.hourly[h][key] = (d.hourly[h][key] || 0) + 1;
  d.totals[key] = (d.totals[key] || 0) + 1;
  if (speed != null && d.speeds.length < MAX_SPEEDS_PER_DAY) d.speeds.push(speed);
  scheduleDaySave();
}

const tracker = new ObjectTracker({
  confirmHits: 2,
  maxMisses: 6,
  onConfirmed: (t) => onNewObject(t),
});

/* ---- 5. Modell laden -------------------------------------------------- */
let modelLoading = false;
let modelBase = storage.get("modelBase", "lite_mobilenet_v2"); // "Schnell" | "Genau"
const MODEL_MAX_TRIES = 3;

// Passenden Status setzen, je nachdem ob gerade beobachtet wird.
function setReadyStatus() {
  if (running && !paused) setStatus("Live – Beobachtung läuft", "live");
  else if (running && paused) setStatus("Pausiert", "idle");
  else setStatus("Bereit – Kamera oder Video starten", "idle");
}

async function loadModel(attempt = 1) {
  if (model || modelLoading) return;
  if (typeof cocoSsd === "undefined") {
    // KI-Bibliothek (CDN) nicht verfügbar – z.B. offline beim ersten Aufruf.
    setStatus("KI-Bibliothek nicht erreichbar – hier klicken für neuen Versuch", "error");
    els.status.style.cursor = "pointer";
    return;
  }
  modelLoading = true;
  els.status.style.cursor = "default";
  setStatus(attempt === 1 ? "Modell wird geladen …" : `Modell wird geladen … (Versuch ${attempt})`, "loading");
  try {
    model = await cocoSsd.load({ base: modelBase });
    modelLoading = false;
    els.btnCamera.disabled = false;
    setReadyStatus();
  } catch (err) {
    console.error("Modell-Laden fehlgeschlagen:", err);
    modelLoading = false;
    if (attempt < MODEL_MAX_TRIES) {
      // Transiente Netzwerkfehler abfangen: mit wachsendem Abstand erneut versuchen.
      setStatus(`Verbindung unterbrochen – neuer Versuch …`, "loading");
      setTimeout(() => loadModel(attempt + 1), 1200 * attempt);
    } else {
      setStatus("Modell nicht geladen – hier klicken für neuen Versuch", "error");
      els.status.style.cursor = "pointer";
    }
  }
}

// Genauigkeit umschalten: Modell austauschen (Beobachtung läuft nahtlos weiter).
function switchModel(base) {
  if (base === modelBase && model) return;
  modelBase = base;
  storage.set("modelBase", base);
  model = null; // detectLoop pausiert automatisch, bis das neue Modell geladen ist
  setStatus("Modell wird gewechselt …", "loading");
  loadModel(1);
}

/* ---- 6. Quellen: Kamera / Video --------------------------------------- */
async function startCamera(deviceId) {
  if (!model) return;
  stopStream();
  try {
    const constraints = {
      audio: false,
      video: deviceId
        ? { deviceId: { exact: deviceId } }
        : { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } },
    };
    stream = await navigator.mediaDevices.getUserMedia(constraints);
    video.srcObject = stream;
    video.removeAttribute("src");
    video.loop = false;
    await video.play();
    source = "camera";
    onSourceReady();
    await populateCameraList();
  } catch (err) {
    console.error(err);
    if (err.name === "NotAllowedError" || err.name === "SecurityError") {
      setStatus("Kamerazugriff abgelehnt", "error");
    } else if (err.name === "NotFoundError") {
      setStatus("Keine Kamera gefunden", "error");
    } else {
      setStatus("Kamera-Fehler: " + err.name, "error");
    }
  }
}

function loadVideoFile(file) {
  if (!model || !file) return;
  stopStream();
  const url = URL.createObjectURL(file);
  video.srcObject = null;
  video.src = url;
  video.loop = true;
  video.play().then(() => {
    source = "video";
    onSourceReady();
  }).catch((err) => {
    console.error(err);
    setStatus("Video konnte nicht abgespielt werden", "error");
  });
}

function onSourceReady() {
  els.videoHint.style.display = "none";
  els.btnPause.disabled = false;
  paused = false;
  els.btnPause.textContent = "⏸ Pause";
  if (!obsStart) obsStart = performance.now();
  setStatus("Live – Beobachtung läuft", "live");
  if (!running) { running = true; scheduleNextDetect(); }
}

function stopStream() {
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
}

async function populateCameraList() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cams = devices.filter((d) => d.kind === "videoinput");
    if (cams.length <= 1) { els.cameraSelect.hidden = true; return; }
    els.cameraSelect.innerHTML = "";
    cams.forEach((cam, i) => {
      const opt = document.createElement("option");
      opt.value = cam.deviceId;
      opt.textContent = cam.label || `Kamera ${i + 1}`;
      els.cameraSelect.appendChild(opt);
    });
    const activeId = stream?.getVideoTracks()[0]?.getSettings()?.deviceId;
    if (activeId) els.cameraSelect.value = activeId;
    els.cameraSelect.hidden = false;
  } catch { /* enumerateDevices kann fehlschlagen – nicht kritisch */ }
}

/* ---- 7. Erkennungs-Schleife ------------------------------------------ */
async function detectLoop() {
  if (!running) return;
  const now = performance.now();

  if (!paused && model && video.readyState >= 2 && video.videoWidth > 0 &&
      now - lastDetectTs >= DETECT_INTERVAL_MS) {
    const dt = now - lastDetectTs;
    lastDetectTs = now;

    const minScore = Number(els.confSlider.value) / 100;
    let predictions = [];
    try {
      predictions = await model.detect(video, MAX_BOXES, minScore);
    } catch (err) {
      console.error("detect() fehlgeschlagen:", err);
    }
    processDetections(predictions, now, dt);
  }
  scheduleNextDetect();
}

// setTimeout statt rAF: läuft (gedrosselt) auch im Hintergrund-Tab weiter,
// nötig für die optionale Hintergrund-Überwachung. rAF pausiert dort komplett.
function scheduleNextDetect() {
  setTimeout(detectLoop, document.hidden ? 250 : 30);
}

function processDetections(predictions, now, dt) {
  // Nur relevante Klassen behalten und in Tracker-Format bringen.
  let dets = [];
  for (const p of predictions) {
    if (CATEGORIES[p.class]) dets.push({ class: p.class, score: p.score, bbox: p.bbox });
  }
  // Beobachtungs-Zone: Detektionen außerhalb des Bereichs ignorieren.
  if (zone) dets = dets.filter((d) => inZone(d.bbox));
  if (autoCalibActive) collectAutoCalib(dets);
  if (collecting && !paused) {
    const iv = (Number(els.collectInterval.value) || 4) * 1000;
    if (now - lastCollectTs >= iv) { lastCollectTs = now; captureFrame(dets); }
  }

  // Kalibrierung: entweder 2-Punkt-Referenz oder Slider „Straßenbreite".
  tracker.setFrameSize(video.videoWidth, video.videoHeight);
  tracker.setMetersPerPixel(metersPerPixel());

  const tracks = tracker.update(dets, now);
  if (line) checkLineCrossings(tracks); // Zähllinie auswerten

  // Live-Zählung aus aktiven Tracks.
  liveCounts = Object.fromEntries(CATEGORY_KEYS.map((k) => [k, 0]));
  for (const t of tracks) liveCounts[t.class] = (liveCounts[t.class] || 0) + 1;

  lastTracks = tracks;
  drawOverlay(tracks);
  updateStats(tracks);

  // FPS glätten.
  if (dt > 0) {
    const fps = 1000 / dt;
    smoothedFps = smoothedFps ? smoothedFps * 0.8 + fps * 0.2 : fps;
  }
  els.fpsMeter.textContent = `${smoothedFps.toFixed(0)} FPS`;
  const objs = tracks.length;
  els.objMeter.textContent = `${objs} Objekt${objs === 1 ? "" : "e"} im Bild`;
}

/* ---- 8. Overlay zeichnen (Bounding-Boxes) ----------------------------- */
function syncOverlaySize() {
  const rect = overlay.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(rect.width * dpr);
  const h = Math.round(rect.height * dpr);
  if (overlay.width !== w || overlay.height !== h) {
    overlay.width = w;
    overlay.height = h;
  }
  octx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { w: rect.width, h: rect.height };
}

// Abbildung Video-Pixel -> angezeigte Fläche (object-fit: contain).
function videoMapper(viewW, viewH) {
  const vw = video.videoWidth, vh = video.videoHeight;
  const scale = Math.min(viewW / vw, viewH / vh);
  const dw = vw * scale, dh = vh * scale;
  const ox = (viewW - dw) / 2, oy = (viewH - dh) / 2;
  return { scale, ox, oy };
}

function drawOverlay(tracks) {
  const { w, h } = syncOverlaySize();
  octx.clearRect(0, 0, w, h);
  if (!video.videoWidth) return;
  const m = videoMapper(w, h);

  // Bereich außerhalb der Zone abdunkeln (nicht während des Zeichnens).
  if (zone && editMode !== "zone") drawZoneMask(m, w, h);

  // Erkannte Objekte.
  octx.textBaseline = "top";
  for (const t of tracks) {
    const cat = CATEGORIES[t.class];
    const x = m.ox + t.bbox[0] * m.scale;
    const y = m.oy + t.bbox[1] * m.scale;
    const bw = t.bbox[2] * m.scale;
    const bh = t.bbox[3] * m.scale;

    octx.lineWidth = 2;
    octx.strokeStyle = cat.color;
    octx.strokeRect(x, y, bw, bh);

    let label = `${cat.emoji} ${cat.singular}`;
    if (cat.vehicle && t.speedKmh != null && t.speedKmh >= 3) {
      label += `  ${Math.round(t.speedKmh)} km/h`;
    }
    octx.font = "600 13px -apple-system, system-ui, sans-serif";
    const tw = octx.measureText(label).width;
    const ly = y > 20 ? y - 20 : y + bh;
    octx.fillStyle = cat.color;
    octx.fillRect(x - 1, ly, tw + 12, 19);
    octx.fillStyle = "#08111c";
    octx.fillText(label, x + 5, ly + 3);
  }

  // Zone-Rahmen, Zähllinie, Kalibrier-Referenz und Maßstab oben drauf.
  drawZoneOutline(m);
  drawLine(m);
  drawCalibLine(m);
  drawCalibrationScale(m);
}

/* ---- 8b. Zone & Zähllinie: Zeichnen + Maus/Touch --------------------- */
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// normalisierte (0..1) -> Canvas-CSS-Pixel
function normToCanvas(nx, ny, m) {
  return { x: m.ox + nx * video.videoWidth * m.scale, y: m.oy + ny * video.videoHeight * m.scale };
}

function inZone(bbox) {
  const nx = (bbox[0] + bbox[2] / 2) / video.videoWidth;
  const ny = (bbox[1] + bbox[3] / 2) / video.videoHeight;
  return nx >= zone.x && nx <= zone.x + zone.w && ny >= zone.y && ny <= zone.y + zone.h;
}

function currentZoneRect() {
  if (editMode === "zone" && dragStart && dragCurrent) {
    return {
      x: Math.min(dragStart.nx, dragCurrent.nx), y: Math.min(dragStart.ny, dragCurrent.ny),
      w: Math.abs(dragCurrent.nx - dragStart.nx), h: Math.abs(dragCurrent.ny - dragStart.ny),
    };
  }
  return zone;
}

function drawZoneMask(m, w, h) {
  const p = normToCanvas(zone.x, zone.y, m);
  const dw = zone.w * video.videoWidth * m.scale, dh = zone.h * video.videoHeight * m.scale;
  octx.fillStyle = "rgba(5,7,11,0.55)";
  octx.fillRect(0, 0, w, h);
  octx.clearRect(p.x, p.y, dw, dh); // Zonenbereich wieder freilegen
}

function drawZoneOutline(m) {
  const z = currentZoneRect();
  if (!z || z.w <= 0 || z.h <= 0) return;
  const p = normToCanvas(z.x, z.y, m);
  const dw = z.w * video.videoWidth * m.scale, dh = z.h * video.videoHeight * m.scale;
  octx.strokeStyle = "#38bdf8";
  octx.lineWidth = 2;
  octx.setLineDash([7, 4]);
  octx.strokeRect(p.x, p.y, dw, dh);
  octx.setLineDash([]);
  octx.fillStyle = "#38bdf8";
  octx.font = "600 12px -apple-system, system-ui, sans-serif";
  octx.textBaseline = "top";
  octx.fillText("Zone", p.x + 5, p.y + 4);
}

function currentLine() {
  if (editMode === "line" && dragStart && dragCurrent) {
    return { x1: dragStart.nx, y1: dragStart.ny, x2: dragCurrent.nx, y2: dragCurrent.ny };
  }
  return line;
}

function drawLine(m) {
  const l = currentLine();
  if (!l) return;
  const a = normToCanvas(l.x1, l.y1, m), b = normToCanvas(l.x2, l.y2, m);
  octx.strokeStyle = "#f7d154";
  octx.lineWidth = 3;
  octx.beginPath(); octx.moveTo(a.x, a.y); octx.lineTo(b.x, b.y); octx.stroke();
  octx.fillStyle = "#f7d154";
  for (const p of [a, b]) { octx.beginPath(); octx.arc(p.x, p.y, 4, 0, Math.PI * 2); octx.fill(); }
}

// 2-Punkt-Kalibrier-Referenz zeichnen (präzise Strecke mit bekannter Länge).
function drawCalibLine(m) {
  const c = (editMode === "calib" && dragStart && dragCurrent)
    ? { x1: dragStart.nx, y1: dragStart.ny, x2: dragCurrent.nx, y2: dragCurrent.ny, meters: null }
    : calib;
  if (!c) return;
  const a = normToCanvas(c.x1, c.y1, m), b = normToCanvas(c.x2, c.y2, m);
  octx.strokeStyle = "#22d3ee";
  octx.lineWidth = 3;
  octx.setLineDash([]);
  octx.beginPath(); octx.moveTo(a.x, a.y); octx.lineTo(b.x, b.y); octx.stroke();
  octx.fillStyle = "#22d3ee";
  for (const p of [a, b]) { octx.beginPath(); octx.arc(p.x, p.y, 4, 0, Math.PI * 2); octx.fill(); }
  if (c.meters) {
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const label = `📏 ${c.meters} m`;
    octx.font = "600 13px -apple-system, system-ui, sans-serif";
    octx.textAlign = "center";
    octx.textBaseline = "bottom";
    const tw = octx.measureText(label).width;
    octx.fillStyle = "rgba(8,17,28,0.85)";
    octx.fillRect(mx - tw / 2 - 6, my - 24, tw + 12, 20);
    octx.fillStyle = "#22d3ee";
    octx.fillText(label, mx, my - 8);
    octx.textAlign = "left";
  }
}

// Maßstab am unteren Bildrand: zeigt, welche reale Breite die Bildbreite meint
// (Grundlage der Tempo-Schätzung). Nach dem Verstellen kurz hervorgehoben.
function drawCalibrationScale(m) {
  if (calib) return; // bei präziser 2-Punkt-Kalibrierung keinen Bildbreiten-Maßstab zeigen
  const meters = Number(els.calibSlider.value);
  const dw = video.videoWidth * m.scale;
  const dh = video.videoHeight * m.scale;
  const x0 = m.ox, x1 = m.ox + dw;
  const y = m.oy + dh - Math.min(40, dh * 0.13);
  const pxPerM = dw / meters;
  const recent = performance.now() < calibShowUntil;

  // Tick-Abstand so wählen, dass nicht zu viele Markierungen entstehen.
  const step = [1, 2, 5, 10, 20, 50].find((s) => meters / s <= 15) || 100;

  octx.save();
  octx.globalAlpha = recent ? 1 : 0.5;
  octx.strokeStyle = "#ffffff";
  octx.fillStyle = "#ffffff";
  octx.shadowColor = "rgba(0,0,0,0.85)";
  octx.shadowBlur = 3;

  octx.lineWidth = 2;
  octx.beginPath(); octx.moveTo(x0, y); octx.lineTo(x1, y); octx.stroke();          // Hauptlinie
  for (const ex of [x0, x1]) {                                                       // Endkappen
    octx.beginPath(); octx.moveTo(ex, y - 9); octx.lineTo(ex, y + 9); octx.stroke();
  }
  octx.lineWidth = 1;
  for (let mtr = step; mtr < meters; mtr += step) {                                  // Meter-Ticks
    const tx = x0 + mtr * pxPerM;
    octx.beginPath(); octx.moveTo(tx, y - 4); octx.lineTo(tx, y + 4); octx.stroke();
  }
  octx.font = `600 ${recent ? 14 : 12}px -apple-system, system-ui, sans-serif`;
  octx.textAlign = "center";
  octx.textBaseline = "bottom";
  octx.fillText(`↔ Straßenbreite ≈ ${meters} m`, (x0 + x1) / 2, y - 11);
  octx.restore();
}

function pointerToNorm(evt) {
  const rect = overlay.getBoundingClientRect();
  const m = videoMapper(rect.width, rect.height);
  const vx = (evt.clientX - rect.left - m.ox) / m.scale;
  const vy = (evt.clientY - rect.top - m.oy) / m.scale;
  return { nx: clamp(vx / video.videoWidth, 0, 1), ny: clamp(vy / video.videoHeight, 0, 1) };
}

function setEditMode(mode) {
  editMode = mode;
  overlay.style.pointerEvents = mode ? "auto" : "none";
  overlay.style.cursor = mode ? "crosshair" : "default";
  els.toolHint.textContent =
    mode === "zone" ? "Ziehe ein Rechteck über den Bereich, der beobachtet werden soll." :
    mode === "line" ? "Ziehe eine Linie über die Straße – gezählt wird beim Überqueren." :
    mode === "calib" ? "Ziehe eine Linie über eine Strecke mit bekannter realer Länge." : "";
  els.toolHint.hidden = !mode;
  updateToolButtons();
}

function updateToolButtons() {
  els.btnZone.classList.toggle("is-active", editMode === "zone");
  els.btnLine.classList.toggle("is-active", editMode === "line");
  els.btnZone.classList.toggle("has-shape", !!zone && editMode !== "zone");
  els.btnLine.classList.toggle("has-shape", !!line && editMode !== "line");
  els.btnCalib.classList.toggle("is-active", editMode === "calib");
  els.btnCalib.classList.toggle("has-shape", !!calib && editMode !== "calib");
  els.btnZoneClear.hidden = !zone;
  els.btnLineClear.hidden = !line;
  els.btnCalibClear.hidden = !calib;
}

function onPointerDown(e) {
  if (!editMode || !video.videoWidth) return;
  try { overlay.setPointerCapture(e.pointerId); } catch { /* nicht kritisch */ }
  dragStart = dragCurrent = pointerToNorm(e);
}
function onPointerMove(e) {
  if (!editMode || !dragStart) return;
  dragCurrent = pointerToNorm(e);
  drawOverlay(lastTracks);
}
function onPointerUp(e) {
  if (!editMode || !dragStart) return;
  const end = pointerToNorm(e);
  if (editMode === "zone") {
    const z = {
      x: Math.min(dragStart.nx, end.nx), y: Math.min(dragStart.ny, end.ny),
      w: Math.abs(end.nx - dragStart.nx), h: Math.abs(end.ny - dragStart.ny),
    };
    if (z.w > 0.02 && z.h > 0.02) { zone = z; storage.set("zone", zone); }
  } else if (editMode === "line") {
    if (Math.hypot(end.nx - dragStart.nx, end.ny - dragStart.ny) > 0.05) {
      line = { x1: dragStart.nx, y1: dragStart.ny, x2: end.nx, y2: end.ny };
      storage.set("line", line);
      resetLineSides();
    }
  } else if (editMode === "calib") {
    if (Math.hypot(end.nx - dragStart.nx, end.ny - dragStart.ny) > 0.03) {
      const input = prompt(
        "Wie lang ist diese Strecke in echt? (in Metern)\n" +
        "Tipp: geparktes Auto ≈ 4,5 m · Fahrbahnbreite pro Spur ≈ 3 m",
        calib ? String(calib.meters) : "4.5"
      );
      const meters = parseFloat((input || "").replace(",", "."));
      if (meters > 0) {
        calib = { x1: dragStart.nx, y1: dragStart.ny, x2: end.nx, y2: end.ny, meters };
        storage.set("calib", calib);
      }
    }
  }
  dragStart = dragCurrent = null;
  setEditMode(null);        // nach dem Ziehen Zeichenmodus verlassen
  updateDirectionBar();
  drawOverlay(lastTracks);
}

/* ---- 9. Statistik-Kacheln -------------------------------------------- */
function buildStatCards() {
  els.statGrid.innerHTML = "";
  for (const key of CATEGORY_KEYS) {
    const cat = CATEGORIES[key];
    const card = document.createElement("div");
    card.className = "stat-card";
    card.id = `stat-${key}`;
    card.style.setProperty("--cat-color", cat.color);
    card.innerHTML = `
      <div class="stat-head"><span class="stat-emoji">${cat.emoji}</span> ${cat.label}</div>
      <div class="stat-nums">
        <span class="stat-total" id="total-${key}">0</span>
        <span class="stat-now">jetzt <b id="now-${key}">0</b></span>
      </div>
      <div class="stat-speed" id="speed-${key}"></div>`;
    els.statGrid.appendChild(card);
  }
}

function updateStats(tracks) {
  for (const key of CATEGORY_KEYS) {
    $(`total-${key}`).textContent = totals[key];
    $(`now-${key}`).textContent = liveCounts[key];
    $(`stat-${key}`).classList.toggle("is-active", liveCounts[key] > 0);

    // Ø-Tempo bewegter Fahrzeuge dieser Kategorie.
    if (CATEGORIES[key].vehicle) {
      const speeds = tracks
        .filter((t) => t.class === key && t.speedKmh != null && t.speedKmh >= 3)
        .map((t) => t.speedKmh);
      const el = $(`speed-${key}`);
      if (speeds.length) {
        const avg = speeds.reduce((a, b) => a + b, 0) / speeds.length;
        el.textContent = `Ø ~${Math.round(avg)} km/h`;
      } else {
        el.textContent = "";
      }
    }
  }
}

/* ---- 10. Zählen + loggen --------------------------------------------- */
// Grobe km/h eines Fahrzeug-Tracks (oder null bei Personen/Tieren/Stillstand).
function trackSpeed(track) {
  const cat = CATEGORIES[track.class];
  return cat.vehicle && track.speedKmh != null && track.speedKmh >= 3
    ? Math.round(track.speedKmh) : null;
}

// Vom Tracker aufgerufen, sobald ein Objekt bestätigt ist.
function onNewObject(track) {
  // Ist eine Zähllinie aktiv, wird erst beim Überqueren gezählt (checkLineCrossings).
  if (line) return;
  registerCount(track.class, trackSpeed(track), null);
}

// Zentrale Zählstelle: kumulativ + optional Richtung + Log.
function registerCount(key, speed, direction) {
  totals[key] = (totals[key] || 0) + 1;
  addToDay(key, speed);
  if (direction === "a") dirTotals.a[key] = (dirTotals.a[key] || 0) + 1;
  else if (direction === "b") dirTotals.b[key] = (dirTotals.b[key] || 0) + 1;

  const secs = observationMs() / 1000;
  logRows.push({ time: new Date(), secs, key, speed, dir: direction });
  if (logRows.length > MAX_LOG_ROWS) logRows.shift();
  addLogEntry(CATEGORIES[key], speed, direction);
  if (direction) updateDirectionBar();
  drawDayChart();
  drawWeekChart();
  drawSpeedStats();
  checkAlarm(key, speed);
}

function addLogEntry(cat, speed, direction) {
  // "Log ist leer"-Platzhalter entfernen.
  const empty = els.log.querySelector(".log-empty");
  if (empty) empty.remove();

  const li = document.createElement("li");
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  const arrow = direction ? directionArrows()[direction] + " " : "";
  li.innerHTML = `
    <span class="log-time">${hh}:${mm}:${ss}</span>
    <span class="log-emoji">${cat.emoji}</span>
    <span class="log-text">${arrow}${cat.singular}${speed ? ` · ~${speed} km/h` : ""}</span>`;
  els.log.prepend(li);
  while (els.log.children.length > 60) els.log.lastChild.remove();
}

/* ---- 10b. Zähllinie: Überquerungen + Richtung ------------------------ */
function checkLineCrossings(tracks) {
  const dx = line.x2 - line.x1, dy = line.y2 - line.y1;
  for (const t of tracks) {
    const nx = (t.bbox[0] + t.bbox[2] / 2) / video.videoWidth;
    const ny = (t.bbox[1] + t.bbox[3] / 2) / video.videoHeight;
    // Vorzeichen = auf welcher Seite der Linie liegt das Objekt?
    const side = Math.sign(dx * (ny - line.y1) - dy * (nx - line.x1));
    if (side === 0) continue;                       // genau auf der Linie -> abwarten
    if (t._lineSide === undefined) { t._lineSide = side; continue; }
    if (side !== t._lineSide) {                      // Seitenwechsel = Überquerung
      const direction = (t._lineSide < 0 && side > 0) ? "a" : "b";
      registerCount(t.class, trackSpeed(t), direction);
      t._lineSide = side;
    }
  }
}

function resetLineSides() {
  for (const t of tracker.getTracks()) delete t._lineSide;
}

// Pfeil-Symbole passend zur Linien-Ausrichtung (a = Bewegung von Seite − nach +).
function directionArrows() {
  if (!line) return { a: "→", b: "←" };
  const nx = -(line.y2 - line.y1), ny = (line.x2 - line.x1); // Richtung steigender "side"
  if (Math.abs(nx) >= Math.abs(ny)) return nx > 0 ? { a: "→", b: "←" } : { a: "←", b: "→" };
  return ny > 0 ? { a: "↓", b: "↑" } : { a: "↑", b: "↓" };
}

function updateDirectionBar() {
  if (!line) { els.dirBar.hidden = true; return; }
  els.dirBar.hidden = false;
  const sum = (o) => Object.values(o).reduce((s, n) => s + n, 0);
  els.dirA.textContent = sum(dirTotals.a);
  els.dirB.textContent = sum(dirTotals.b);
  const arr = directionArrows();
  els.dirAArrow.textContent = arr.a;
  els.dirBArrow.textContent = arr.b;
}

/* ---- 10c. Alarm & Schnappschüsse ------------------------------------ */
const MAX_SNAPSHOTS = 12;
function loadAlarm() {
  return Object.assign(
    { cats: [], speedOn: false, speedVal: 50, sound: true, snap: true, notify: false, background: false },
    storage.get("alarm", {})
  );
}
let alarmSettings = loadAlarm();
const snapshots = [];    // {dataUrl, label} – nur in dieser Sitzung
let audioCtx = null;

function saveAlarm() { storage.set("alarm", alarmSettings); }

function buildAlarmCategories() {
  els.alarmCats.innerHTML = CATEGORY_KEYS.map((k) =>
    `<label class="alarm-cat"><input type="checkbox" data-cat="${k}"${alarmSettings.cats.includes(k) ? " checked" : ""} /> ${CATEGORIES[k].emoji} ${CATEGORIES[k].singular}</label>`
  ).join("");
  els.alarmCats.querySelectorAll("input").forEach((inp) => {
    inp.addEventListener("change", () => {
      const k = inp.dataset.cat;
      if (inp.checked) { if (!alarmSettings.cats.includes(k)) alarmSettings.cats.push(k); }
      else alarmSettings.cats = alarmSettings.cats.filter((c) => c !== k);
      saveAlarm();
    });
  });
}

// Wird nach jeder Zählung aufgerufen.
function checkAlarm(key, speed) {
  const s = alarmSettings;
  const catHit = s.cats.includes(key);
  const speedHit = s.speedOn && speed != null && speed >= s.speedVal;
  if (!catHit && !speedHit) return;
  if (s.sound) playBeep();
  if (s.snap) captureSnapshot(key, speed);
  if (s.notify) sendNotification(key, speed);
}

let lastNotifyTs = 0;
function sendNotification(key, speed) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const now = Date.now();
  if (now - lastNotifyTs < 8000) return; // nicht spammen: max 1 alle 8 s
  lastNotifyTs = now;
  const cat = CATEGORIES[key];
  try {
    new Notification("StreetPulse", {
      body: `${cat.emoji} ${cat.singular} erkannt${speed ? " · ~" + speed + " km/h" : ""}`,
      tag: "streetpulse-alarm",
    });
  } catch { /* z.B. auf iOS ohne Support */ }
}

function updateNotifyHint() {
  if (!alarmSettings.notify) { els.notifyHint.textContent = ""; return; }
  if (!("Notification" in window)) { els.notifyHint.textContent = "Dieser Browser unterstützt keine Benachrichtigungen."; return; }
  const p = Notification.permission;
  els.notifyHint.textContent = p === "granted" ? "✓ Benachrichtigungen erlaubt."
    : p === "denied" ? "⚠ Im Browser blockiert – in den Seiteneinstellungen erlauben."
    : "Bitte im Browser-Dialog erlauben.";
}

/* ---- 10d. Zeitgesteuerte Aufnahme ----------------------------------- */
let schedule = storage.get("schedule", { on: false, from: "08:00", to: "09:00" });
let schedulePaused = false;
function saveSchedule() { storage.set("schedule", schedule); }
function nowHHMM() {
  const n = new Date();
  return String(n.getHours()).padStart(2, "0") + ":" + String(n.getMinutes()).padStart(2, "0");
}
function withinWindow(cur, from, to) {
  return from <= to ? (cur >= from && cur < to) : (cur >= from || cur < to); // auch über Mitternacht
}
function updateSchedStatus() {
  if (!schedule.on) { els.schedStatus.textContent = ""; return; }
  els.schedStatus.textContent = withinWindow(nowHHMM(), schedule.from, schedule.to)
    ? "● läuft" : "wartet auf " + schedule.from;
}
// Alle 15 s geprüft: startet/pausiert die Aufnahme im gewählten Zeitfenster.
function checkSchedule() {
  updateSchedStatus();
  if (!schedule.on || !model) return;
  const inWin = withinWindow(nowHHMM(), schedule.from, schedule.to);
  if (inWin) {
    if (!running) startCamera();                            // Fenster beginnt -> Kamera starten
    else if (paused && schedulePaused) { schedulePaused = false; setPaused(false); }
  } else if (running && !paused) {
    schedulePaused = true; setPaused(true);                 // Fenster vorbei -> pausieren
  }
}

function playBeep() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
    const t = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(880, t);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
    osc.connect(gain); gain.connect(audioCtx.destination);
    osc.start(t); osc.stop(t + 0.36);
  } catch { /* Audio nicht verfügbar */ }
}

function captureSnapshot(key, speed) {
  if (!video.videoWidth) return;
  const c = document.createElement("canvas");
  c.width = video.videoWidth;
  c.height = video.videoHeight;
  const cx = c.getContext("2d");
  cx.drawImage(video, 0, 0, c.width, c.height);
  const cat = CATEGORIES[key];
  const text = `${cat.emoji} ${cat.singular}${speed ? " ~" + speed + " km/h" : ""} · ${new Date().toLocaleTimeString("de-DE")}`;
  const barH = 30;
  cx.fillStyle = "rgba(0,0,0,0.6)";
  cx.fillRect(0, c.height - barH, c.width, barH);
  cx.fillStyle = "#fff";
  cx.font = "600 20px -apple-system, system-ui, sans-serif";
  cx.textBaseline = "middle";
  cx.fillText(text, 10, c.height - barH / 2);
  snapshots.unshift({ dataUrl: c.toDataURL("image/jpeg", 0.7), label: text });
  if (snapshots.length > MAX_SNAPSHOTS) snapshots.pop();
  renderGallery();
}

function renderGallery() {
  if (!snapshots.length) {
    els.gallery.innerHTML = `<p class="gallery-empty">Noch keine Aufnahmen. Bei einem Alarm wird automatisch ein Foto gespeichert (bleibt nur in dieser Sitzung).</p>`;
    els.galleryCount.textContent = "";
    return;
  }
  els.galleryCount.textContent = `(${snapshots.length})`;
  els.gallery.innerHTML = snapshots.map((s, i) =>
    `<a class="snap" href="${s.dataUrl}" download="streetpulse-foto-${i + 1}.jpg" title="${s.label} – klicken zum Speichern"><img src="${s.dataUrl}" alt="${s.label}" /></a>`
  ).join("");
}

/* ---- 11. Verlaufs-Diagramm ------------------------------------------- */
function sampleHistory() {
  if (!running || paused) return; // nur während aktiver Beobachtung aufzeichnen
  history.push({ ...liveCounts });
  if (history.length > HISTORY_LENGTH) history.shift();
  drawChart();
}

function drawChart() {
  const dpr = window.devicePixelRatio || 1;
  const rect = chartCanvas.getBoundingClientRect();
  const w = rect.width, h = rect.height;
  chartCanvas.width = Math.round(w * dpr);
  chartCanvas.height = Math.round(h * dpr);
  cctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  cctx.clearRect(0, 0, w, h);

  const padL = 28, padR = 8, padT = 10, padB = 18;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  // Welche Kategorien kamen im Fenster überhaupt vor?
  const activeKeys = CATEGORY_KEYS.filter((k) => history.some((pt) => pt[k] > 0));
  let maxVal = 1;
  for (const pt of history) for (const k of activeKeys) maxVal = Math.max(maxVal, pt[k]);
  maxVal = Math.ceil(maxVal);

  // Gitter + Y-Achse.
  cctx.strokeStyle = THEME.grid;
  cctx.fillStyle = THEME.axisText;
  cctx.lineWidth = 1;
  cctx.font = "11px -apple-system, system-ui, sans-serif";
  cctx.textBaseline = "middle";
  const lines = 3;
  for (let i = 0; i <= lines; i++) {
    const val = Math.round((maxVal / lines) * i);
    const y = padT + plotH - (val / maxVal) * plotH;
    cctx.beginPath();
    cctx.moveTo(padL, y);
    cctx.lineTo(padL + plotW, y);
    cctx.stroke();
    cctx.fillText(String(val), 4, y);
  }
  // X-Beschriftung
  cctx.textBaseline = "alphabetic";
  cctx.fillText("−60s", padL, h - 4);
  cctx.textAlign = "right";
  cctx.fillText("jetzt", padL + plotW, h - 4);
  cctx.textAlign = "left";

  // Linien pro aktiver Kategorie.
  const n = history.length;
  if (n >= 2) {
    for (const key of activeKeys) {
      cctx.strokeStyle = CATEGORIES[key].color;
      cctx.lineWidth = 2;
      cctx.beginPath();
      history.forEach((pt, i) => {
        const x = padL + (i / (HISTORY_LENGTH - 1)) * plotW;
        const y = padT + plotH - (pt[key] / maxVal) * plotH;
        i === 0 ? cctx.moveTo(x, y) : cctx.lineTo(x, y);
      });
      cctx.stroke();
    }
  }

  renderLegend(activeKeys);
}

function renderLegend(activeKeys) {
  els.chartLegend.innerHTML = activeKeys.length
    ? activeKeys.map((k) =>
        `<span class="legend-item"><span class="legend-dot" style="background:${CATEGORIES[k].color}"></span>${CATEGORIES[k].label}</span>`
      ).join("")
    : `<span class="subtle">Noch keine Daten – Beobachtung starten.</span>`;
}

/* ---- 11b. Tagesverlauf-Diagramm (gestapelte Stundenbalken) ----------- */
function drawDayChart() {
  const dpr = window.devicePixelRatio || 1;
  const rect = dayCanvas.getBoundingClientRect();
  const w = rect.width, h = rect.height;
  dayCanvas.width = Math.round(w * dpr);
  dayCanvas.height = Math.round(h * dpr);
  dctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  dctx.clearRect(0, 0, w, h);

  const d = currentDay();
  const padL = 26, padR = 8, padT = 10, padB = 20;
  const plotW = w - padL - padR, plotH = h - padT - padB;

  const activeKeys = CATEGORY_KEYS.filter((k) => d.hourly.some((hr) => hr[k] > 0));
  let maxVal = 1;
  for (const hr of d.hourly) {
    maxVal = Math.max(maxVal, CATEGORY_KEYS.reduce((s, k) => s + (hr[k] || 0), 0));
  }
  maxVal = Math.ceil(maxVal);

  // Gitter + Y-Achse
  dctx.strokeStyle = THEME.grid;
  dctx.fillStyle = THEME.axisText;
  dctx.font = "11px -apple-system, system-ui, sans-serif";
  dctx.textBaseline = "middle";
  dctx.lineWidth = 1;
  for (let i = 0; i <= 2; i++) {
    const val = Math.round((maxVal / 2) * i);
    const y = padT + plotH - (val / maxVal) * plotH;
    dctx.beginPath(); dctx.moveTo(padL, y); dctx.lineTo(padL + plotW, y); dctx.stroke();
    dctx.fillText(String(val), 3, y);
  }

  // gestapelte Balken je Stunde
  const bw = plotW / 24;
  for (let hr = 0; hr < 24; hr++) {
    let yBase = padT + plotH;
    const x = padL + hr * bw;
    for (const k of CATEGORY_KEYS) {
      const v = d.hourly[hr][k] || 0;
      if (!v) continue;
      const segH = (v / maxVal) * plotH;
      dctx.fillStyle = CATEGORIES[k].color;
      dctx.fillRect(x + 1, yBase - segH, Math.max(1, bw - 2), segH);
      yBase -= segH;
    }
  }

  // X-Achse (Stunden)
  dctx.fillStyle = THEME.axisText;
  dctx.textBaseline = "alphabetic";
  dctx.textAlign = "center";
  for (let hr = 0; hr <= 24; hr += 6) {
    dctx.fillText(hr + "h", padL + hr * bw, h - 6);
  }
  dctx.textAlign = "left";

  renderDayLegend(activeKeys);
}

function renderDayLegend(activeKeys) {
  els.dayLegend.innerHTML = activeKeys.length
    ? activeKeys.map((k) =>
        `<span class="legend-item"><span class="legend-dot" style="background:${CATEGORIES[k].color}"></span>${CATEGORIES[k].label}</span>`
      ).join("")
    : `<span class="subtle">Heute noch keine Daten aufgezeichnet.</span>`;
}

/* ---- 11c. Tempo-Statistik ------------------------------------------- */
function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

// Kennzahlen der heutigen Fahrzeug-Geschwindigkeiten.
function speedStats() {
  const speeds = currentDay().speeds || [];
  if (!speeds.length) return null;
  const sorted = [...speeds].sort((a, b) => a - b);
  const sum = sorted.reduce((s, v) => s + v, 0);
  const limit = Number(els.speedLimit.value) || 50;
  const over = sorted.filter((v) => v > limit).length;
  return {
    count: sorted.length,
    avg: Math.round(sum / sorted.length),
    p85: Math.round(percentile(sorted, 85)),
    max: Math.round(sorted[sorted.length - 1]),
    overPct: Math.round((over / sorted.length) * 100),
    limit, sorted,
  };
}

function drawSpeedStats() {
  const st = speedStats();
  els.spdCount.textContent = st ? st.count : "–";
  els.spdAvg.textContent = st ? st.avg : "–";
  els.spdP85.textContent = st ? st.p85 : "–";
  els.spdMax.textContent = st ? st.max : "–";
  els.spdOver.textContent = st ? st.overPct + "%" : "–";
  els.spdHint.textContent = st
    ? "85 %-Wert = Tempo, das 85 % nicht überschreiten (Standard der Verkehrsplanung)"
    : "Noch keine Tempo-Daten – Fahrzeuge müssen sich sichtbar bewegen.";
  drawSpeedHistogram(st);
}

function drawSpeedHistogram(st) {
  const dpr = window.devicePixelRatio || 1;
  const rect = speedCanvas.getBoundingClientRect();
  const w = rect.width, h = rect.height;
  speedCanvas.width = Math.round(w * dpr);
  speedCanvas.height = Math.round(h * dpr);
  spctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  spctx.clearRect(0, 0, w, h);
  if (!st) return;

  const padL = 24, padR = 8, padT = 8, padB = 18;
  const plotW = w - padL - padR, plotH = h - padT - padB;
  const bucket = 10;
  const maxSpeed = Math.max(60, Math.ceil(st.max / bucket) * bucket);
  const n = maxSpeed / bucket;
  const buckets = Array(n).fill(0);
  for (const v of st.sorted) buckets[Math.min(n - 1, Math.floor(v / bucket))]++;
  const maxCount = Math.max(1, ...buckets);
  const bw = plotW / n;

  for (let i = 0; i < n; i++) {
    const bh = (buckets[i] / maxCount) * plotH;
    spctx.fillStyle = i * bucket >= st.limit ? "#f87171" : "#4f9dff";
    spctx.fillRect(padL + i * bw + 1, padT + plotH - bh, Math.max(1, bw - 2), bh);
  }
  // Tempolimit-Markierung
  const lx = padL + (st.limit / maxSpeed) * plotW;
  spctx.strokeStyle = "#fbbf24"; spctx.lineWidth = 1.5; spctx.setLineDash([4, 3]);
  spctx.beginPath(); spctx.moveTo(lx, padT); spctx.lineTo(lx, padT + plotH); spctx.stroke();
  spctx.setLineDash([]);
  // Achse
  spctx.fillStyle = THEME.axisText; spctx.font = "11px -apple-system, system-ui, sans-serif";
  spctx.textBaseline = "alphabetic"; spctx.textAlign = "center";
  for (let s = 0; s <= maxSpeed; s += 20) spctx.fillText(String(s), padL + (s / maxSpeed) * plotW, h - 5);
  spctx.textAlign = "right"; spctx.fillText("km/h", w - 2, h - 5); spctx.textAlign = "left";
}

/* ---- 11d. Mehrtägiger Verlauf --------------------------------------- */
function drawWeekChart() {
  const dpr = window.devicePixelRatio || 1;
  const rect = weekCanvas.getBoundingClientRect();
  const w = rect.width, h = rect.height;
  weekCanvas.width = Math.round(w * dpr);
  weekCanvas.height = Math.round(h * dpr);
  wctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  wctx.clearRect(0, 0, w, h);

  const dateKeys = Object.keys(days).sort();
  const padL = 24, padR = 8, padT = 10, padB = 22;
  const plotW = w - padL - padR, plotH = h - padT - padB;
  const dayTotal = (dk, k) => (days[dk].totals && days[dk].totals[k]) || 0;

  if (!dateKeys.length) { renderWeekLegend([]); return; }
  let maxVal = 1;
  for (const dk of dateKeys) maxVal = Math.max(maxVal, CATEGORY_KEYS.reduce((s, k) => s + dayTotal(dk, k), 0));
  maxVal = Math.ceil(maxVal);
  const activeKeys = CATEGORY_KEYS.filter((k) => dateKeys.some((dk) => dayTotal(dk, k) > 0));

  wctx.strokeStyle = THEME.grid; wctx.fillStyle = THEME.axisText;
  wctx.font = "11px -apple-system, system-ui, sans-serif"; wctx.textBaseline = "middle"; wctx.lineWidth = 1;
  for (let i = 0; i <= 2; i++) {
    const val = Math.round((maxVal / 2) * i);
    const y = padT + plotH - (val / maxVal) * plotH;
    wctx.beginPath(); wctx.moveTo(padL, y); wctx.lineTo(padL + plotW, y); wctx.stroke();
    wctx.fillText(String(val), 3, y);
  }
  const bw = plotW / dateKeys.length;
  dateKeys.forEach((dk, i) => {
    let yBase = padT + plotH;
    const x = padL + i * bw;
    for (const k of CATEGORY_KEYS) {
      const v = dayTotal(dk, k);
      if (!v) continue;
      const segH = (v / maxVal) * plotH;
      wctx.fillStyle = CATEGORIES[k].color;
      wctx.fillRect(x + 2, yBase - segH, Math.max(1, bw - 4), segH);
      yBase -= segH;
    }
    if (dateKeys.length <= 10 || i === 0 || i === dateKeys.length - 1) {
      const [, mo, da] = dk.split("-");
      wctx.fillStyle = THEME.axisText; wctx.textAlign = "center"; wctx.textBaseline = "alphabetic";
      wctx.fillText(`${da}.${mo}.`, x + bw / 2, h - 6);
      wctx.textAlign = "left";
    }
  });
  renderWeekLegend(activeKeys);
}

function renderWeekLegend(activeKeys) {
  els.weekLegend.innerHTML = activeKeys.length
    ? activeKeys.map((k) =>
        `<span class="legend-item"><span class="legend-dot" style="background:${CATEGORIES[k].color}"></span>${CATEGORIES[k].label}</span>`
      ).join("")
    : `<span class="subtle">Noch keine Tagesdaten gespeichert.</span>`;
}

/* ---- 11f. Muster lernen: Insights, Anomalie, Vorhersage ------------- */
function computeInsights() {
  const dateKeys = Object.keys(days).sort();
  const today = dateStr(new Date());
  const todayData = days[today] || null;
  const pastKeys = dateKeys.filter((k) => k !== today);
  const catSum = (o) => CATEGORY_KEYS.reduce((s, c) => s + ((o && o[c]) || 0), 0);

  // Durchschnittliches Stundenmuster aus den Vortagen -> "gelerntes" Normalmuster
  const hourlyAvg = Array(24).fill(0);
  if (pastKeys.length) {
    for (let h = 0; h < 24; h++) {
      let sum = 0;
      for (const k of pastKeys) sum += catSum(days[k].hourly[h]);
      hourlyAvg[h] = sum / pastKeys.length;
    }
  }

  const todayTotal = todayData ? catSum(todayData.totals) : 0;
  const pastTotals = pastKeys.map((k) => catSum(days[k].totals));
  const avgPastTotal = pastTotals.length ? pastTotals.reduce((a, b) => a + b, 0) / pastTotals.length : null;

  let peakHour = null, peakVal = 0;
  if (todayData) for (let h = 0; h < 24; h++) {
    const v = catSum(todayData.hourly[h]);
    if (v > peakVal) { peakVal = v; peakHour = h; }
  }

  // Typische Stoßzeiten = Stunden mit dem höchsten Durchschnitt
  const rushHours = hourlyAvg.map((v, h) => ({ h, v })).filter((x) => x.v > 0)
    .sort((a, b) => b.v - a.v).slice(0, 2).map((x) => x.h).sort((a, b) => a - b);

  // Anomalie: laufende Stunde vs. gelernte Erwartung
  let anomaly = null;
  if (pastKeys.length >= 2 && todayData) {
    const h = new Date().getHours();
    const actual = catSum(todayData.hourly[h]);
    const expected = hourlyAvg[h];
    if (expected >= 3) {
      const ratio = actual / expected;
      if (ratio >= 1.8) anomaly = { type: "hoch", hour: h, actual, expected: Math.round(expected) };
      else if (ratio <= 0.4) anomaly = { type: "niedrig", hour: h, actual, expected: Math.round(expected) };
    }
  }

  return { todayData, todayTotal, avgPastTotal, peakHour, peakVal, hourlyAvg, rushHours, anomaly, nPastDays: pastKeys.length };
}

// Klartext-Bericht (lokal aus den Daten – kein Cloud-Dienst nötig)
function generateSummaryText() {
  const ins = computeInsights();
  const st = speedStats();
  const d = currentDay();
  if (ins.todayTotal === 0) {
    return { text: "Heute wurden noch keine Objekte gezählt. Sobald die Beobachtung läuft, erscheint hier eine automatische Auswertung.", anomaly: null };
  }
  const p = [];
  p.push(`Heute (${d.date}) wurden bisher ${ins.todayTotal} Objekte erfasst.`);
  if (ins.avgPastTotal != null) {
    const diff = Math.round((ins.todayTotal / ins.avgPastTotal - 1) * 100);
    p.push(Math.abs(diff) >= 15
      ? `Das sind rund ${Math.abs(diff)} % ${diff > 0 ? "mehr" : "weniger"} als der Schnitt der letzten ${ins.nPastDays} Tage.`
      : `Das liegt etwa im Schnitt der letzten ${ins.nPastDays} Tage.`);
  }
  const cats = CATEGORY_KEYS.map((k) => ({ k, n: d.totals[k] || 0 })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n);
  if (cats.length) p.push(`Am häufigsten: ${cats.slice(0, 3).map((x) => `${x.n}× ${CATEGORIES[x.k].label}`).join(", ")}.`);
  if (ins.peakHour != null && ins.peakVal > 0) p.push(`Am meisten los war es gegen ${ins.peakHour}–${ins.peakHour + 1} Uhr.`);
  if (st) {
    p.push(`Fahrzeuge fuhren im Schnitt etwa ${st.avg} km/h (85-%-Wert ${st.p85}, Spitze ${st.max} km/h).`);
    if (st.overPct > 0) p.push(`${st.overPct} % waren schneller als ${st.limit} km/h${st.overPct >= 20 ? " – auffällig viele" : ""}.`);
  }
  if (ins.rushHours.length) p.push(`Typische Stoßzeiten laut Historie: ${ins.rushHours.map((h) => `${h}–${h + 1} Uhr`).join(" und ")}.`);
  return { text: p.join(" "), anomaly: ins.anomaly };
}

function updateSummary() {
  const { text, anomaly } = generateSummaryText();
  els.summaryText.textContent = text;
  if (anomaly) {
    els.anomalyBadge.hidden = false;
    els.anomalyBadge.textContent = anomaly.type === "hoch"
      ? `⚠ Gerade ungewöhnlich viel Verkehr (${anomaly.actual} statt sonst ~${anomaly.expected} um diese Zeit).`
      : `ℹ Gerade ungewöhnlich wenig Verkehr (${anomaly.actual} statt sonst ~${anomaly.expected} um diese Zeit).`;
  } else {
    els.anomalyBadge.hidden = true;
  }
}

/* ---- 11g. Auto-Kalibrierung aus erkannten Autos --------------------- */
let autoCalibActive = false;
let autoCalibSamples = [];
let autoCalibUntil = 0;
const ASSUMED_CAR_WIDTH_M = 2.0; // grobe reale Breite/Perspektive eines Autos

function startAutoCalib() {
  if (!running || !video.videoWidth) { showToolHint("Bitte zuerst Kamera oder Video starten."); return; }
  autoCalibActive = true;
  autoCalibSamples = [];
  autoCalibUntil = performance.now() + 8000;
  showToolHint("🎯 Auto-Kalibrierung läuft … Autos vorbeifahren lassen (ca. 8 s).");
}

function collectAutoCalib(dets) {
  for (const d of dets) if (d.class === "car") autoCalibSamples.push(d.bbox[2]);
  if (performance.now() > autoCalibUntil) finishAutoCalib();
}

function finishAutoCalib() {
  autoCalibActive = false;
  if (autoCalibSamples.length < 4) {
    showToolHint("⚠ Zu wenige Autos erkannt – bitte erneut versuchen.", 3500);
    return;
  }
  autoCalibSamples.sort((a, b) => a - b);
  const median = autoCalibSamples[Math.floor(autoCalibSamples.length / 2)];
  const roadWidth = Math.max(3, Math.min(60, Math.round(ASSUMED_CAR_WIDTH_M * video.videoWidth / median)));
  calib = null; storage.remove("calib"); // 2-Punkt-Kalibrierung aufheben -> Slider gilt
  els.calibSlider.value = roadWidth;
  els.calibVal.innerHTML = roadWidth + "&nbsp;m";
  calibShowUntil = performance.now() + 3000;
  updateToolButtons();
  drawOverlay(lastTracks);
  showToolHint(`🎯 Auto-kalibriert: Bildbreite ≈ ${roadWidth} m (aus ${autoCalibSamples.length} Autos).`, 4500);
}

// Kurz einen Hinweis im Banner zeigen.
let toolHintTimer = null;
function showToolHint(text, ms) {
  els.toolHint.textContent = text;
  els.toolHint.hidden = false;
  clearTimeout(toolHintTimer);
  if (ms) toolHintTimer = setTimeout(() => { if (!editMode) els.toolHint.hidden = true; }, ms);
}

/* ---- 11h. Trainingsdaten sammeln (IndexedDB + YOLO-Export) ---------- */
let _idb = null;
function idbOpen() {
  return new Promise((resolve, reject) => {
    if (_idb) return resolve(_idb);
    const req = indexedDB.open("streetpulse-frames", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("frames", { keyPath: "id", autoIncrement: true });
    req.onsuccess = () => { _idb = req.result; resolve(_idb); };
    req.onerror = () => reject(req.error);
  });
}
function idbTx(mode, fn) {
  return idbOpen().then((db) => new Promise((res, rej) => {
    const tx = db.transaction("frames", mode);
    const r = fn(tx.objectStore("frames"));
    tx.oncomplete = () => res(r ? r.result : undefined);
    tx.onerror = () => rej(tx.error);
  }));
}
const idbAdd = (obj) => idbTx("readwrite", (s) => s.add(obj));
const idbGetAll = () => idbTx("readonly", (s) => s.getAll());
const idbCount = () => idbTx("readonly", (s) => s.count());
const idbClear = () => idbTx("readwrite", (s) => s.clear());

let collecting = false;
let lastCollectTs = 0;
let collectCount = 0;

async function updateCollectCount() {
  try { collectCount = await idbCount(); } catch { collectCount = 0; }
  els.collectCount.textContent = `${collectCount} Bild${collectCount === 1 ? "" : "er"}`;
}

function toggleCollect() {
  collecting = !collecting;
  els.btnCollect.textContent = collecting ? "⏹ Sammeln stoppen" : "📸 Sammeln starten";
  els.btnCollect.classList.toggle("is-collecting", collecting);
  if (collecting && (!running || paused)) showToolHint("Tipp: Kamera oder Video starten, damit Bilder gesammelt werden.", 4000);
}

// Aktuellen Frame samt Vor-Markierungen (YOLO) sichern – nur Frames mit Objekten.
function captureFrame(dets) {
  if (!video.videoWidth || !dets.length) return;
  const c = document.createElement("canvas");
  c.width = video.videoWidth; c.height = video.videoHeight;
  c.getContext("2d").drawImage(video, 0, 0, c.width, c.height);
  const labels = dets.map((d) => {
    const id = CATEGORY_KEYS.indexOf(d.class);
    const cx = (d.bbox[0] + d.bbox[2] / 2) / c.width;
    const cy = (d.bbox[1] + d.bbox[3] / 2) / c.height;
    return `${id} ${cx.toFixed(6)} ${cy.toFixed(6)} ${(d.bbox[2] / c.width).toFixed(6)} ${(d.bbox[3] / c.height).toFixed(6)}`;
  }).join("\n");
  idbAdd({ time: Date.now(), dataUrl: c.toDataURL("image/jpeg", 0.8), labels })
    .then(updateCollectCount).catch((e) => console.error("Frame speichern:", e));
}

async function downloadTrainingZip() {
  if (typeof JSZip === "undefined") { showToolHint("ZIP-Bibliothek nicht geladen – Seite neu laden.", 4000); return; }
  const frames = await idbGetAll();
  if (!frames || !frames.length) { showToolHint("Noch keine Trainingsbilder gesammelt.", 3500); return; }
  const zip = new JSZip();
  zip.file("classes.txt", CATEGORY_KEYS.join("\n"));
  zip.file("data.yaml", `# StreetPulse-Trainingsdaten (YOLO-Format)\nnc: ${CATEGORY_KEYS.length}\nnames: [${CATEGORY_KEYS.map((k) => `'${k}'`).join(", ")}]\n`);
  frames.forEach((f, i) => {
    const n = String(i + 1).padStart(4, "0");
    zip.file(`images/img_${n}.jpg`, f.dataUrl.split(",")[1], { base64: true });
    zip.file(`labels/img_${n}.txt`, f.labels);
  });
  const blob = await zip.generateAsync({ type: "blob" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `streetpulse-training_${new Date().toISOString().slice(0, 10)}.zip`;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function clearTrainingData() {
  if (!collectCount) return;
  if (!confirm(`${collectCount} gesammelte Trainingsbilder wirklich löschen?`)) return;
  await idbClear();
  updateCollectCount();
}

/* ---- 11e. Teilbarer Report (PNG) ------------------------------------ */
function generateReport() {
  drawDayChart(); drawWeekChart(); drawSpeedStats(); // Diagramme aktuell halten
  const d = currentDay();
  const st = speedStats();
  const W = 900, P = 36;
  const c = document.createElement("canvas");
  c.width = W; c.height = 1310;
  const x = c.getContext("2d");
  x.fillStyle = "#0e1117"; x.fillRect(0, 0, W, c.height);
  x.textBaseline = "top";

  // Kopf
  x.fillStyle = "#4f9dff"; x.font = "700 32px -apple-system, system-ui, sans-serif";
  x.fillText("StreetPulse – Verkehrs-Report", P, 34);
  x.fillStyle = "#93a1b3"; x.font = "15px -apple-system, system-ui, sans-serif";
  x.fillText(`Erstellt am ${new Date().toLocaleString("de-DE")}  ·  Beobachtungstag: ${d.date}`, P, 76);

  // Zusammenfassung in Klartext (umbrochen)
  x.fillStyle = "#c8d3e0"; x.font = "15px -apple-system, system-ui, sans-serif";
  let sy = 108;
  let line = "";
  for (const word of generateSummaryText().text.split(" ")) {
    const test = line ? line + " " + word : word;
    if (x.measureText(test).width > W - 2 * P && line) { x.fillText(line, P, sy); sy += 23; line = word; }
    else line = test;
  }
  if (line) { x.fillText(line, P, sy); sy += 23; }

  const header = (title, y) => {
    x.fillStyle = "#e6edf3"; x.font = "600 19px -apple-system, system-ui, sans-serif";
    x.fillText(title, P, y);
    x.strokeStyle = "#2b3444"; x.lineWidth = 1;
    x.beginPath(); x.moveTo(P, y + 28); x.lineTo(W - P, y + 28); x.stroke();
    return y + 42;
  };
  const kpiCard = (cx, cy, cw, val, lbl, color) => {
    x.fillStyle = "#1a2029"; x.strokeStyle = "#2b3444";
    x.beginPath(); x.roundRect(cx, cy, cw, 66, 10); x.fill(); x.stroke();
    x.fillStyle = color || "#e6edf3"; x.font = "700 26px -apple-system, system-ui, sans-serif";
    x.fillText(String(val), cx + 12, cy + 10);
    x.fillStyle = "#93a1b3"; x.font = "12px -apple-system, system-ui, sans-serif";
    x.fillText(lbl, cx + 12, cy + 44);
  };

  // Zählung heute
  let y = header("Zählung heute", sy + 12);
  const cols = 4, gap = 10, cw = (W - 2 * P - (cols - 1) * gap) / cols;
  CATEGORY_KEYS.forEach((k, i) => {
    const cx = P + (i % cols) * (cw + gap);
    const cy = y + Math.floor(i / cols) * (66 + gap);
    kpiCard(cx, cy, cw, d.totals[k] || 0, `${CATEGORIES[k].emoji} ${CATEGORIES[k].label}`, CATEGORIES[k].color);
  });
  y += 2 * (66 + gap) + 12;

  // Tempo-Statistik
  y = header("Geschwindigkeit" + (calib ? " (2-Punkt-kalibriert)" : " (grobe Schätzung)"), y);
  if (st) {
    const items = [
      [st.count, "Fahrzeuge"], [st.avg + " km/h", "Ø-Tempo"], [st.p85 + " km/h", "85 %-Wert"],
      [st.max + " km/h", "Spitze"], [st.overPct + " %", "über " + st.limit + " km/h"],
    ];
    const scw = (W - 2 * P - 4 * gap) / 5;
    items.forEach(([v, l], i) => kpiCard(P + i * (scw + gap), y, scw, v, l, i === 4 ? "#f87171" : "#e6edf3"));
    y += 66 + 12;
  } else {
    x.fillStyle = "#93a1b3"; x.font = "14px -apple-system, system-ui, sans-serif";
    x.fillText("Noch keine Tempo-Messungen vorhanden.", P, y); y += 30;
  }

  // Diagramme einbetten
  const chartBlock = (title, canvas, yy, hgt) => {
    x.fillStyle = "#93a1b3"; x.font = "600 14px -apple-system, system-ui, sans-serif";
    x.fillText(title, P, yy);
    if (canvas.width) x.drawImage(canvas, P, yy + 22, W - 2 * P, hgt);
    return yy + 22 + hgt + 16;
  };
  y = chartBlock("Tagesverlauf (pro Stunde)", dayCanvas, y, 150);
  if (st) y = chartBlock("Tempo-Verteilung", speedCanvas, y, 130);
  y = chartBlock("Mehrtägiger Verlauf (pro Tag)", weekCanvas, y, 130);

  // Fuß
  x.fillStyle = "#64748b"; x.font = "12px -apple-system, system-ui, sans-serif";
  x.fillText("Erstellt mit StreetPulse · lokale Webcam-Zählung · Tempo-Werte sind Schätzungen (abhängig von Kamerawinkel & Kalibrierung).", P, c.height - 34);

  const a = document.createElement("a");
  a.href = c.toDataURL("image/png");
  a.download = `streetpulse-report_${d.date}.png`;
  a.click();
}

/* ---- 12. CSV-Export --------------------------------------------------- */
function exportCsv() {
  const lines = [];
  lines.push("# StreetPulse Export – " + new Date().toLocaleString("de-DE"));
  lines.push("# Gesamtzählung:");
  for (const key of CATEGORY_KEYS) {
    lines.push(`# ${CATEGORIES[key].label};${totals[key]}`);
  }
  if (line) {
    const sum = (o) => Object.values(o).reduce((s, n) => s + n, 0);
    lines.push(`# Zähllinie Richtung A gesamt;${sum(dirTotals.a)}`);
    lines.push(`# Zähllinie Richtung B gesamt;${sum(dirTotals.b)}`);
  }
  lines.push("");
  lines.push("Uhrzeit;Sekunde_seit_Start;Kategorie;Tempo_kmh;Richtung");
  for (const row of logRows) {
    const t = row.time.toLocaleTimeString("de-DE");
    lines.push(`${t};${row.secs.toFixed(1)};${CATEGORIES[row.key].label};${row.speed ?? ""};${row.dir ? row.dir.toUpperCase() : ""}`);
  }
  const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  a.download = `streetpulse_${stamp}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/* ---- 13. Steuerung / Events ------------------------------------------ */
function setPaused(value) {
  if (paused === value || !running) return;
  paused = value;
  if (paused) {
    // Uhr anhalten und bereits verstrichene aktive Zeit sichern.
    if (obsStart) { obsAccumMs += performance.now() - obsStart; obsStart = 0; }
  } else {
    obsStart = performance.now();
  }
  els.btnPause.textContent = paused ? "▶ Weiter" : "⏸ Pause";
  setStatus(paused ? "Pausiert" : "Live – Beobachtung läuft", paused ? "idle" : "live");
  if (source === "video") paused ? video.pause() : video.play();
}

function togglePause() {
  autoPaused = false; // manuelle Bedienung hat Vorrang vor Auto-Pause
  setPaused(!paused);
}

function resetCounts() {
  for (const k of CATEGORY_KEYS) totals[k] = 0;
  liveCounts = Object.fromEntries(CATEGORY_KEYS.map((k) => [k, 0]));
  history.length = 0;
  logRows.length = 0;
  tracker.reset();
  dirTotals = { a: {}, b: {} };
  resetLineSides();
  days[dateStr(new Date())] = freshDay(dateStr(new Date())); // nur heute verwerfen
  storage.set("days", days);
  obsAccumMs = 0;
  obsStart = (running && !paused) ? performance.now() : 0;
  els.log.innerHTML = `<li class="log-empty">Noch keine Ereignisse …</li>`;
  updateStats([]);
  updateDirectionBar();
  drawChart();
  drawDayChart();
  drawWeekChart();
  drawSpeedStats();
}

function setStatus(text, kind) {
  els.status.textContent = text;
  els.status.className = "status status--" + kind;
}

function updateRuntime() {
  const secs = Math.floor(observationMs() / 1000);
  const mm = String(Math.floor(secs / 60)).padStart(2, "0");
  const ss = String(secs % 60).padStart(2, "0");
  els.runtimeMeter.textContent = `Laufzeit ${mm}:${ss}`;
}

function bindEvents() {
  els.btnCamera.addEventListener("click", () => startCamera());
  els.btnCamera.disabled = true; // bis Modell geladen ist
  els.btnPause.addEventListener("click", togglePause);
  els.videoFile.addEventListener("change", (e) => {
    if (e.target.files[0]) loadVideoFile(e.target.files[0]);
  });
  els.cameraSelect.addEventListener("change", (e) => startCamera(e.target.value));
  els.btnReset.addEventListener("click", resetCounts);
  els.btnExport.addEventListener("click", exportCsv);
  els.modelSelect.addEventListener("change", (e) => switchModel(e.target.value));
  els.btnDayClear.addEventListener("click", resetCounts);
  els.btnReport.addEventListener("click", generateReport);
  els.speedLimit.addEventListener("change", () => {
    storage.set("speedLimit", Number(els.speedLimit.value) || 50);
    drawSpeedStats();
  });

  // Alarm-Einstellungen
  els.alarmSpeedOn.addEventListener("change", () => { alarmSettings.speedOn = els.alarmSpeedOn.checked; saveAlarm(); });
  els.alarmSpeedVal.addEventListener("change", () => { alarmSettings.speedVal = Number(els.alarmSpeedVal.value) || 50; saveAlarm(); });
  els.alarmSound.addEventListener("change", () => { alarmSettings.sound = els.alarmSound.checked; saveAlarm(); });
  els.alarmSnap.addEventListener("change", () => { alarmSettings.snap = els.alarmSnap.checked; saveAlarm(); });
  els.alarmNotify.addEventListener("change", () => {
    alarmSettings.notify = els.alarmNotify.checked;
    saveAlarm();
    if (alarmSettings.notify && "Notification" in window && Notification.permission === "default") {
      Notification.requestPermission().then(updateNotifyHint);
    }
    updateNotifyHint();
  });
  els.alarmBackground.addEventListener("change", () => {
    alarmSettings.background = els.alarmBackground.checked; saveAlarm();
  });
  // Zeitgesteuerte Aufnahme
  els.schedOn.addEventListener("change", () => { schedule.on = els.schedOn.checked; saveSchedule(); checkSchedule(); });
  els.schedFrom.addEventListener("change", () => { schedule.from = els.schedFrom.value || "08:00"; saveSchedule(); checkSchedule(); });
  els.schedTo.addEventListener("change", () => { schedule.to = els.schedTo.value || "09:00"; saveSchedule(); checkSchedule(); });

  // Zone & Zähllinie
  els.btnZone.addEventListener("click", () => setEditMode(editMode === "zone" ? null : "zone"));
  els.btnLine.addEventListener("click", () => setEditMode(editMode === "line" ? null : "line"));
  els.btnZoneClear.addEventListener("click", () => {
    zone = null; storage.remove("zone"); updateToolButtons(); drawOverlay(lastTracks);
  });
  els.btnLineClear.addEventListener("click", () => {
    line = null; storage.remove("line"); resetLineSides();
    updateToolButtons(); updateDirectionBar(); drawOverlay(lastTracks);
  });
  els.btnCalib.addEventListener("click", () => setEditMode(editMode === "calib" ? null : "calib"));
  els.btnCalibClear.addEventListener("click", () => {
    calib = null; storage.remove("calib"); updateToolButtons(); drawOverlay(lastTracks);
  });
  els.btnAutoCalib.addEventListener("click", startAutoCalib);
  els.btnSummary.addEventListener("click", updateSummary);
  els.btnTheme.addEventListener("click", toggleTheme);
  els.btnCollect.addEventListener("click", toggleCollect);
  els.btnCollectZip.addEventListener("click", downloadTrainingZip);
  els.btnCollectClear.addEventListener("click", clearTrainingData);
  overlay.addEventListener("pointerdown", onPointerDown);
  overlay.addEventListener("pointermove", onPointerMove);
  overlay.addEventListener("pointerup", onPointerUp);
  els.confSlider.addEventListener("input", () => {
    els.confVal.innerHTML = els.confSlider.value + "&nbsp;%";
  });
  els.calibSlider.addEventListener("input", () => {
    els.calibVal.innerHTML = els.calibSlider.value + "&nbsp;m";
    // Maßstab im Bild sofort zeigen und kurz hervorheben (auch bei Pause).
    calibShowUntil = performance.now() + 2500;
    drawOverlay(lastTracks);
    clearTimeout(calibHideTimer);
    calibHideTimer = setTimeout(() => drawOverlay(lastTracks), 2600);
  });
  // Klick auf Status im Fehlerfall -> Modell erneut laden.
  els.status.addEventListener("click", () => {
    if (!model && !modelLoading) loadModel(1);
  });
  // Tab-Wechsel: Erkennung läuft im Hintergrund ohnehin nicht (rAF pausiert),
  // also automatisch pausieren, damit Uhr & Diagramm nicht verfälscht werden.
  document.addEventListener("visibilitychange", () => {
    if (!running) return;
    // Hintergrund-Überwachung aktiv? Dann weiterlaufen lassen (Loop tickt via setTimeout).
    if (alarmSettings.background) {
      if (document.hidden && paused && autoPaused) { autoPaused = false; setPaused(false); }
      return;
    }
    if (document.hidden && !paused) { autoPaused = true; setPaused(true); }
    else if (!document.hidden && autoPaused) { autoPaused = false; setPaused(false); }
  });
  window.addEventListener("resize", () => { if (video.videoWidth) drawChart(); });
}

/* ---- 14. Start -------------------------------------------------------- */
function init() {
  buildStatCards();
  bindEvents();
  els.modelSelect.value = modelBase;
  els.speedLimit.value = storage.get("speedLimit", 50);
  // Alarm-Einstellungen in die UI übernehmen
  buildAlarmCategories();
  els.alarmSpeedOn.checked = alarmSettings.speedOn;
  els.alarmSpeedVal.value = alarmSettings.speedVal;
  els.alarmSound.checked = alarmSettings.sound;
  els.alarmSnap.checked = alarmSettings.snap;
  els.alarmNotify.checked = alarmSettings.notify;
  els.alarmBackground.checked = alarmSettings.background;
  updateNotifyHint();
  // Zeitplan-Einstellungen übernehmen
  els.schedOn.checked = schedule.on;
  els.schedFrom.value = schedule.from;
  els.schedTo.value = schedule.to;
  updateSchedStatus();
  // heutige, gespeicherte Zählung in die Anzeige übernehmen (überlebt Reload)
  const dToday = currentDay();
  for (const k of CATEGORY_KEYS) totals[k] = dToday.totals[k] || 0;
  els.log.innerHTML = `<li class="log-empty">Noch keine Ereignisse …</li>`;
  updateStats([]);
  updateDirectionBar();
  updateToolButtons();       // gespeicherte Zone/Linie in den Buttons spiegeln
  renderGallery();
  applyTheme(); // setzt Theme + zeichnet alle Diagramme mit den passenden Farben
  updateSummary();
  updateCollectCount();
  setInterval(sampleHistory, 1000);
  setInterval(updateRuntime, 1000);
  setInterval(checkSchedule, 15000);
  setInterval(updateSummary, 20000);
  loadModel();
}

init();
