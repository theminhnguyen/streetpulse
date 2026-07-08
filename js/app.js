import { ObjectTracker } from "./tracker.js";

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
const els = {
  status: $("status"), btnCamera: $("btnCamera"), btnPause: $("btnPause"),
  cameraSelect: $("cameraSelect"), videoFile: $("videoFile"), btnReset: $("btnReset"),
  btnExport: $("btnExport"), confSlider: $("confSlider"), confVal: $("confVal"),
  calibSlider: $("calibSlider"), calibVal: $("calibVal"), videoHint: $("videoHint"),
  statGrid: $("statGrid"), fpsMeter: $("fpsMeter"), objMeter: $("objMeter"),
  runtimeMeter: $("runtimeMeter"), chartLegend: $("chartLegend"), log: $("log"),
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
const logRows = [];      // {time, secs, key, speed}

const tracker = new ObjectTracker({
  confirmHits: 2,
  maxMisses: 6,
  onConfirmed: (t) => onNewObject(t),
});

/* ---- 5. Modell laden -------------------------------------------------- */
let modelLoading = false;
const MODEL_MAX_TRIES = 3;

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
    model = await cocoSsd.load({ base: "lite_mobilenet_v2" });
    modelLoading = false;
    setStatus("Bereit – Kamera oder Video starten", "idle");
    els.btnCamera.disabled = false;
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
  const dets = [];
  for (const p of predictions) {
    if (CATEGORIES[p.class]) dets.push({ class: p.class, score: p.score, bbox: p.bbox });
  }

  // Kalibrierung: Bildbreite (px) entspricht "Straßenbreite" (m).
  const roadWidthM = Number(els.calibSlider.value);
  tracker.setFrameSize(video.videoWidth, video.videoHeight);
  tracker.setMetersPerPixel(roadWidthM / video.videoWidth);

  const tracks = tracker.update(dets, now);

  // Live-Zählung aus aktiven Tracks.
  liveCounts = Object.fromEntries(CATEGORY_KEYS.map((k) => [k, 0]));
  for (const t of tracks) liveCounts[t.class] = (liveCounts[t.class] || 0) + 1;

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
  const { scale, ox, oy } = videoMapper(w, h);

  octx.lineWidth = 2;
  octx.font = "600 13px -apple-system, system-ui, sans-serif";
  octx.textBaseline = "top";

  for (const t of tracks) {
    const cat = CATEGORIES[t.class];
    const x = ox + t.bbox[0] * scale;
    const y = oy + t.bbox[1] * scale;
    const bw = t.bbox[2] * scale;
    const bh = t.bbox[3] * scale;

    // Box
    octx.strokeStyle = cat.color;
    octx.strokeRect(x, y, bw, bh);

    // Label
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

/* ---- 10. Neues Objekt bestätigt -> zählen + loggen ------------------- */
function onNewObject(track) {
  totals[track.class] = (totals[track.class] || 0) + 1;
  const cat = CATEGORIES[track.class];
  const secs = observationMs() / 1000;
  const speed = cat.vehicle && track.speedKmh != null && track.speedKmh >= 3
    ? Math.round(track.speedKmh) : null;

  logRows.push({ time: new Date(), secs, key: track.class, speed });
  if (logRows.length > MAX_LOG_ROWS) logRows.shift();
  addLogEntry(cat, speed);
}

function addLogEntry(cat, speed) {
  // "Log ist leer"-Platzhalter entfernen.
  const empty = els.log.querySelector(".log-empty");
  if (empty) empty.remove();

  const li = document.createElement("li");
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  li.innerHTML = `
    <span class="log-time">${hh}:${mm}:${ss}</span>
    <span class="log-emoji">${cat.emoji}</span>
    <span class="log-text">${cat.singular}${speed ? ` · ~${speed} km/h` : ""}</span>`;
  els.log.prepend(li);
  while (els.log.children.length > 60) els.log.lastChild.remove();
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

/* ---- 12. CSV-Export --------------------------------------------------- */
function exportCsv() {
  const lines = [];
  lines.push("# Fenster-Watch Export – " + new Date().toLocaleString("de-DE"));
  lines.push("# Gesamtzählung:");
  for (const key of CATEGORY_KEYS) {
    lines.push(`# ${CATEGORIES[key].label};${totals[key]}`);
  }
  lines.push("");
  lines.push("Uhrzeit;Sekunde_seit_Start;Kategorie;Tempo_kmh");
  for (const row of logRows) {
    const t = row.time.toLocaleTimeString("de-DE");
    lines.push(`${t};${row.secs.toFixed(1)};${CATEGORIES[row.key].label};${row.speed ?? ""}`);
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
  obsAccumMs = 0;
  obsStart = (running && !paused) ? performance.now() : 0;
  els.log.innerHTML = `<li class="log-empty">Noch keine Ereignisse …</li>`;
  updateStats([]);
  drawChart();
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
  els.confSlider.addEventListener("input", () => {
    els.confVal.innerHTML = els.confSlider.value + "&nbsp;%";
  });
  els.calibSlider.addEventListener("input", () => {
    els.calibVal.innerHTML = els.calibSlider.value + "&nbsp;m";
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
  resetCounts(); // setzt Zähler/Log/Diagramm auf den Startzustand
  setInterval(sampleHistory, 1000);
  setInterval(updateRuntime, 1000);
  loadModel();
}

init();
