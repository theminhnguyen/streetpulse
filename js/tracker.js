/**
 * Einfacher Centroid-basierter Objekt-Tracker.
 *
 * Aufgabe: dieselbe Person / dasselbe Auto über mehrere Frames wiedererkennen,
 * damit wir (a) eindeutig zählen (nicht jeden Frame neu) und (b) aus der
 * Bewegung eine grobe Geschwindigkeit schätzen können.
 *
 * Bewusst schlank gehalten (kein Kalman-Filter, keine Re-ID per Aussehen) –
 * das reicht für einen Proof of Concept mit Verkehr vor dem Fenster.
 */
export class ObjectTracker {
  /**
   * @param {object} opts
   * @param {number} opts.confirmHits   Treffer bis ein Track als "echt" zählt
   * @param {number} opts.maxMisses     Frames ohne Treffer bis ein Track verworfen wird
   * @param {number} opts.speedSmoothing EMA-Faktor (0..1) für die Geschwindigkeitsglättung
   * @param {(track: Track) => void} opts.onConfirmed  Callback bei neuem, bestätigtem Objekt
   */
  constructor(opts = {}) {
    this.confirmHits = opts.confirmHits ?? 3;
    this.maxMisses = opts.maxMisses ?? 6;
    this.speedSmoothing = opts.speedSmoothing ?? 0.4;
    this.onConfirmed = opts.onConfirmed ?? (() => {});

    this.tracks = new Map(); // id -> Track
    this.nextId = 1;
    this.metersPerPixel = null; // wird von außen gesetzt (Kalibrierung)
    this.frameWidth = 1280;
    this.frameDiag = Math.hypot(1280, 720);
  }

  setFrameSize(w, h) {
    if (w > 0 && h > 0) {
      this.frameWidth = w;
      this.frameDiag = Math.hypot(w, h);
    }
  }

  setMetersPerPixel(mpp) {
    this.metersPerPixel = mpp > 0 ? mpp : null;
  }

  reset() {
    this.tracks.clear();
    this.nextId = 1;
  }

  /** Zentrum einer Bounding-Box [x, y, w, h]. */
  static _centroid(b) {
    return { x: b[0] + b[2] / 2, y: b[1] + b[3] / 2 };
  }

  /**
   * Aktualisiert den Tracker mit den Detektionen eines Frames.
   * @param {{class:string, score:number, bbox:number[]}[]} detections
   * @param {number} now  Zeitstempel in ms (performance.now())
   * @returns {Track[]} aktuell aktive Tracks
   */
  update(detections, now) {
    const unmatched = new Set(this.tracks.keys());
    const pairs = [];

    // Alle plausiblen (Detektion, Track)-Paare gleicher Klasse sammeln.
    detections.forEach((det, di) => {
      const c = ObjectTracker._centroid(det.bbox);
      const bboxDiag = Math.hypot(det.bbox[2], det.bbox[3]);
      // Wie weit darf sich ein Objekt zwischen zwei Detektionen bewegt haben?
      const gate = Math.max(bboxDiag * 1.6, this.frameWidth * 0.15);

      this.tracks.forEach((t, id) => {
        if (t.class !== det.class) return;
        const dist = Math.hypot(c.x - t.cx, c.y - t.cy);
        if (dist <= gate) pairs.push({ di, id, dist });
      });
    });

    // Greedy: kürzeste Distanzen zuerst zuordnen (jeweils 1:1).
    pairs.sort((a, b) => a.dist - b.dist);
    const usedDet = new Set();
    const usedTrack = new Set();
    for (const p of pairs) {
      if (usedDet.has(p.di) || usedTrack.has(p.id)) continue;
      usedDet.add(p.di);
      usedTrack.add(p.id);
      unmatched.delete(p.id);
      this._updateTrack(this.tracks.get(p.id), detections[p.di], now);
    }

    // Nicht zugeordnete Detektionen -> neue Tracks.
    detections.forEach((det, di) => {
      if (!usedDet.has(di)) this._createTrack(det, now);
    });

    // Nicht getroffene Tracks altern lassen / verwerfen.
    for (const id of unmatched) {
      const t = this.tracks.get(id);
      t.misses += 1;
      if (t.misses > this.maxMisses) this.tracks.delete(id);
    }

    return this.getTracks();
  }

  _createTrack(det, now) {
    const c = ObjectTracker._centroid(det.bbox);
    const track = {
      id: this.nextId++,
      class: det.class,
      bbox: det.bbox,
      score: det.score,
      cx: c.x,
      cy: c.y,
      firstSeen: now,
      lastSeen: now,
      hits: 1,
      misses: 0,
      counted: false,
      pxPerSec: 0,
      speedKmh: null,
    };
    this.tracks.set(track.id, track);
  }

  _updateTrack(t, det, now) {
    const c = ObjectTracker._centroid(det.bbox);
    const dt = now - t.lastSeen; // ms

    if (dt > 20) {
      const dist = Math.hypot(c.x - t.cx, c.y - t.cy);
      const instantPxPerSec = dist / (dt / 1000);
      // EMA-Glättung gegen Zittern der Bounding-Box.
      t.pxPerSec = t.hits <= 1
        ? instantPxPerSec
        : this.speedSmoothing * instantPxPerSec + (1 - this.speedSmoothing) * t.pxPerSec;

      if (this.metersPerPixel) {
        t.speedKmh = t.pxPerSec * this.metersPerPixel * 3.6;
      }
    }

    t.cx = c.x;
    t.cy = c.y;
    t.bbox = det.bbox;
    t.score = det.score;
    t.lastSeen = now;
    t.hits += 1;
    t.misses = 0;

    // Erst nach mehreren Treffern als echtes Objekt zählen (gegen Fehlalarme).
    if (!t.counted && t.hits >= this.confirmHits) {
      t.counted = true;
      this.onConfirmed(t);
    }
  }

  /** Nur bestätigte (gezählte) Tracks – die zeigen wir an. */
  getTracks() {
    const out = [];
    for (const t of this.tracks.values()) {
      if (t.counted) out.push(t);
    }
    return out;
  }
}
