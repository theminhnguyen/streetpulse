import { ObjectTracker } from "./tracker.js";
import { storage } from "./storage.js";

/* =========================================================================
 * Fenster-Watch – Hauptlogik
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
};

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

/* ---- Tages-Statistik (persistent, überlebt Reload) ------------------- */
function dateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function freshDay(date) {
  return { date, hourly: Array.from({ length: 24 }, () => ({})), totals: {} };
}
function loadDay() {
  const today = dateStr(new Date());
  const saved = storage.get("day", null);
  if (saved && saved.date === today && Array.isArray(saved.hourly) && saved.hourly.length === 24) return saved;
  return freshDay(today);
}
let day = loadDay();
let daySaveTimer = null;

function scheduleDaySave() {
  clearTimeout(daySaveTimer);
  daySaveTimer = setTimeout(() => storage.set("day", day), 1500);
}
function addToDay(key) {
  if (day.date !== dateStr(new Date())) day = freshDay(dateStr(new Date())); // Tageswechsel
  day.hourly[new Date().getHours()][key] = (day.hourly[new Date().getHours()][key] || 0) + 1;
  day.totals[key] = (day.totals[key] || 0) + 1;
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
  if (!running) { running = true; requestAnimationFrame(detectLoop); }
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
  requestAnimationFrame(detectLoop);
}

function processDetections(predictions, now, dt) {
  // Nur relevante Klassen behalten und in Tracker-Format bringen.
  let dets = [];
  for (const p of predictions) {
    if (CATEGORIES[p.class]) dets.push({ class: p.class, score: p.score, bbox: p.bbox });
  }
  // Beobachtungs-Zone: Detektionen außerhalb des Bereichs ignorieren.
  if (zone) dets = dets.filter((d) => inZone(d.bbox));

  // Kalibrierung: Bildbreite (px) entspricht "Straßenbreite" (m).
  const roadWidthM = Number(els.calibSlider.value);
  tracker.setFrameSize(video.videoWidth, video.videoHeight);
  tracker.setMetersPerPixel(roadWidthM / video.videoWidth);

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

  // Zone-Rahmen, Zähllinie und Maßstab oben drauf.
  drawZoneOutline(m);
  drawLine(m);
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

// Maßstab am unteren Bildrand: zeigt, welche reale Breite die Bildbreite meint
// (Grundlage der Tempo-Schätzung). Nach dem Verstellen kurz hervorgehoben.
function drawCalibrationScale(m) {
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
    mode === "line" ? "Ziehe eine Linie über die Straße – gezählt wird beim Überqueren." : "";
  els.toolHint.hidden = !mode;
  updateToolButtons();
}

function updateToolButtons() {
  els.btnZone.classList.toggle("is-active", editMode === "zone");
  els.btnLine.classList.toggle("is-active", editMode === "line");
  els.btnZone.classList.toggle("has-shape", !!zone && editMode !== "zone");
  els.btnLine.classList.toggle("has-shape", !!line && editMode !== "line");
  els.btnZoneClear.hidden = !zone;
  els.btnLineClear.hidden = !line;
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
  addToDay(key);
  if (direction === "a") dirTotals.a[key] = (dirTotals.a[key] || 0) + 1;
  else if (direction === "b") dirTotals.b[key] = (dirTotals.b[key] || 0) + 1;

  const secs = observationMs() / 1000;
  logRows.push({ time: new Date(), secs, key, speed, dir: direction });
  if (logRows.length > MAX_LOG_ROWS) logRows.shift();
  addLogEntry(CATEGORIES[key], speed, direction);
  if (direction) updateDirectionBar();
  drawDayChart();
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
    { cats: [], speedOn: false, speedVal: 50, sound: true, snap: true },
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
    `<a class="snap" href="${s.dataUrl}" download="fenster-watch-foto-${i + 1}.jpg" title="${s.label} – klicken zum Speichern"><img src="${s.dataUrl}" alt="${s.label}" /></a>`
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
  cctx.strokeStyle = "#2b3444";
  cctx.fillStyle = "#64748b";
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

  const padL = 26, padR = 8, padT = 10, padB = 20;
  const plotW = w - padL - padR, plotH = h - padT - padB;

  const activeKeys = CATEGORY_KEYS.filter((k) => day.hourly.some((hr) => hr[k] > 0));
  let maxVal = 1;
  for (const hr of day.hourly) {
    maxVal = Math.max(maxVal, CATEGORY_KEYS.reduce((s, k) => s + (hr[k] || 0), 0));
  }
  maxVal = Math.ceil(maxVal);

  // Gitter + Y-Achse
  dctx.strokeStyle = "#2b3444";
  dctx.fillStyle = "#64748b";
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
      const v = day.hourly[hr][k] || 0;
      if (!v) continue;
      const segH = (v / maxVal) * plotH;
      dctx.fillStyle = CATEGORIES[k].color;
      dctx.fillRect(x + 1, yBase - segH, Math.max(1, bw - 2), segH);
      yBase -= segH;
    }
  }

  // X-Achse (Stunden)
  dctx.fillStyle = "#64748b";
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

/* ---- 12. CSV-Export --------------------------------------------------- */
function exportCsv() {
  const lines = [];
  lines.push("# Fenster-Watch Export – " + new Date().toLocaleString("de-DE"));
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
  a.download = `fenster-watch_${stamp}.csv`;
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
  day = freshDay(dateStr(new Date())); // heutige gespeicherte Statistik verwerfen
  storage.set("day", day);
  obsAccumMs = 0;
  obsStart = (running && !paused) ? performance.now() : 0;
  els.log.innerHTML = `<li class="log-empty">Noch keine Ereignisse …</li>`;
  updateStats([]);
  updateDirectionBar();
  drawChart();
  drawDayChart();
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

  // Alarm-Einstellungen
  els.alarmSpeedOn.addEventListener("change", () => { alarmSettings.speedOn = els.alarmSpeedOn.checked; saveAlarm(); });
  els.alarmSpeedVal.addEventListener("change", () => { alarmSettings.speedVal = Number(els.alarmSpeedVal.value) || 50; saveAlarm(); });
  els.alarmSound.addEventListener("change", () => { alarmSettings.sound = els.alarmSound.checked; saveAlarm(); });
  els.alarmSnap.addEventListener("change", () => { alarmSettings.snap = els.alarmSnap.checked; saveAlarm(); });

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
  // Alarm-Einstellungen in die UI übernehmen
  buildAlarmCategories();
  els.alarmSpeedOn.checked = alarmSettings.speedOn;
  els.alarmSpeedVal.value = alarmSettings.speedVal;
  els.alarmSound.checked = alarmSettings.sound;
  els.alarmSnap.checked = alarmSettings.snap;
  // heutige, gespeicherte Zählung in die Anzeige übernehmen (überlebt Reload)
  for (const k of CATEGORY_KEYS) totals[k] = day.totals[k] || 0;
  els.log.innerHTML = `<li class="log-empty">Noch keine Ereignisse …</li>`;
  updateStats([]);
  updateDirectionBar();
  updateToolButtons();       // gespeicherte Zone/Linie in den Buttons spiegeln
  renderGallery();
  drawChart();
  drawDayChart();
  setInterval(sampleHistory, 1000);
  setInterval(updateRuntime, 1000);
  loadModel();
}

init();
