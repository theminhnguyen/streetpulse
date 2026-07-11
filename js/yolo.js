/**
 * Minimaler YOLOv8-Client für den Browser (ONNX Runtime Web).
 * Lädt ein selbst gehostetes yolov8n.onnx-Modell (models/yolov8n.onnx im
 * eigenen Repo – keine Laufzeit-Abhängigkeit von Drittservern) und liefert
 * Detektionen im selben Format wie COCO-SSD ({class, score, bbox:[x,y,w,h]}),
 * damit es sich nahtlos anstelle von coco-ssd einsetzen lässt.
 *
 * Experimentell: genauer als COCO-SSD/MobileNet, aber größerer Download und
 * mehr Rechenlast. Reale Erkennungsgüte lässt sich nur im echten Einsatz
 * beurteilen (hier nur die Verarbeitungs-Pipeline verifiziert, nicht die
 * inhaltliche Treffergenauigkeit an echten Straßenszenen).
 */

// Standard-COCO-80-Klassenliste in der von YOLO verwendeten Reihenfolge.
export const COCO80 = [
  "person", "bicycle", "car", "motorcycle", "airplane", "bus", "train", "truck", "boat",
  "traffic light", "fire hydrant", "stop sign", "parking meter", "bench", "bird", "cat",
  "dog", "horse", "sheep", "cow", "elephant", "bear", "zebra", "giraffe", "backpack",
  "umbrella", "handbag", "tie", "suitcase", "frisbee", "skis", "snowboard", "sports ball",
  "kite", "baseball bat", "baseball glove", "skateboard", "surfboard", "tennis racket",
  "bottle", "wine glass", "cup", "fork", "knife", "spoon", "bowl", "banana", "apple",
  "sandwich", "orange", "broccoli", "carrot", "hot dog", "pizza", "donut", "cake", "chair",
  "couch", "potted plant", "bed", "dining table", "toilet", "tv", "laptop", "mouse",
  "remote", "keyboard", "cell phone", "microwave", "oven", "toaster", "sink", "refrigerator",
  "book", "clock", "vase", "scissors", "teddy bear", "hair drier", "toothbrush",
];

const INPUT_SIZE = 640;

/** Bereitet ein Video-/Canvas-Frame als YOLO-Eingabetensor auf (Letterbox + Normalisierung). */
export function preprocess(source, srcW, srcH) {
  const scale = Math.min(INPUT_SIZE / srcW, INPUT_SIZE / srcH);
  const dw = Math.round(srcW * scale), dh = Math.round(srcH * scale);
  const padX = Math.floor((INPUT_SIZE - dw) / 2), padY = Math.floor((INPUT_SIZE - dh) / 2);

  const canvas = document.createElement("canvas");
  canvas.width = INPUT_SIZE; canvas.height = INPUT_SIZE;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "rgb(114,114,114)"; // Standard-YOLO-Letterbox-Füllfarbe
  ctx.fillRect(0, 0, INPUT_SIZE, INPUT_SIZE);
  ctx.drawImage(source, 0, 0, srcW, srcH, padX, padY, dw, dh);

  const { data } = ctx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE);
  const chw = new Float32Array(3 * INPUT_SIZE * INPUT_SIZE);
  const plane = INPUT_SIZE * INPUT_SIZE;
  for (let i = 0; i < plane; i++) {
    chw[i] = data[i * 4] / 255;                 // R
    chw[plane + i] = data[i * 4 + 1] / 255;      // G
    chw[2 * plane + i] = data[i * 4 + 2] / 255;  // B
  }
  return { chw, scale, padX, padY };
}

/**
 * Dekodiert den rohen YOLOv8-Output (Standard-Ultralytics-Export ohne
 * eingebautes NMS, Form [1,84,8400] oder [1,8400,84]) zu Boxen im
 * ORIGINAL-Frame-Koordinatensystem, gefiltert auf erlaubte Klassen-Indizes,
 * mit klassenweisem Non-Max-Suppression.
 */
export function postprocess(outputData, outputDims, meta, opts) {
  const { scale, padX, padY } = meta;
  const { scoreThresh = 0.35, iouThresh = 0.45, allowedClasses = null } = opts || {};
  const numAttrs = 84; // 4 Box-Koordinaten + 80 Klassen-Scores

  let numBoxes, getVal;
  if (outputDims[1] === numAttrs) {
    // [1, 84, 8400] – Standard-Ultralytics-Layout
    numBoxes = outputDims[2];
    getVal = (box, attr) => outputData[attr * numBoxes + box];
  } else {
    // [1, 8400, 84] – alternative Export-Variante
    numBoxes = outputDims[1];
    getVal = (box, attr) => outputData[box * numAttrs + attr];
  }

  const candidates = [];
  for (let i = 0; i < numBoxes; i++) {
    let bestScore = 0, bestClass = -1;
    for (let c = 0; c < 80; c++) {
      const s = getVal(i, 4 + c);
      if (s > bestScore) { bestScore = s; bestClass = c; }
    }
    if (bestScore < scoreThresh) continue;
    if (allowedClasses && !allowedClasses.has(bestClass)) continue;

    const cx = getVal(i, 0), cy = getVal(i, 1), w = getVal(i, 2), h = getVal(i, 3);
    // Letterbox rückgängig machen -> Koordinaten im Original-Frame.
    const x1 = (cx - w / 2 - padX) / scale;
    const y1 = (cy - h / 2 - padY) / scale;
    const bw = w / scale, bh = h / scale;
    candidates.push({ classIdx: bestClass, score: bestScore, bbox: [x1, y1, bw, bh] });
  }

  return nms(candidates, iouThresh);
}

function iou(a, b) {
  const [ax, ay, aw, ah] = a.bbox, [bx, by, bw, bh] = b.bbox;
  const x1 = Math.max(ax, bx), y1 = Math.max(ay, by);
  const x2 = Math.min(ax + aw, bx + bw), y2 = Math.min(ay + ah, by + bh);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = aw * ah + bw * bh - inter;
  return union > 0 ? inter / union : 0;
}

// Klassenweises, greedy Non-Max-Suppression (höchster Score zuerst).
function nms(dets, iouThresh) {
  const byClass = new Map();
  for (const d of dets) {
    if (!byClass.has(d.classIdx)) byClass.set(d.classIdx, []);
    byClass.get(d.classIdx).push(d);
  }
  const kept = [];
  for (const list of byClass.values()) {
    list.sort((a, b) => b.score - a.score);
    const used = new Array(list.length).fill(false);
    for (let i = 0; i < list.length; i++) {
      if (used[i]) continue;
      kept.push(list[i]);
      for (let j = i + 1; j < list.length; j++) {
        if (!used[j] && iou(list[i], list[j]) > iouThresh) used[j] = true;
      }
    }
  }
  return kept;
}

// Drop-in-Ersatz für coco-ssd: gleiche .detect(video, maxBoxes, minScore)-API.
export class YoloDetector {
  constructor(session, allowedClassNames) {
    this.session = session;
    this.allowedClasses = new Set(allowedClassNames.map((n) => COCO80.indexOf(n)));
  }
  async detect(video, maxBoxes, minScore) {
    const w = video.videoWidth, h = video.videoHeight;
    const { chw, scale, padX, padY } = preprocess(video, w, h);
    const tensor = new ort.Tensor("float32", chw, [1, 3, INPUT_SIZE, INPUT_SIZE]);
    const feeds = { [this.session.inputNames[0]]: tensor };
    const results = await this.session.run(feeds);
    const out = results[this.session.outputNames[0]];
    const dets = postprocess(out.data, out.dims, { scale, padX, padY }, {
      scoreThresh: minScore, allowedClasses: this.allowedClasses,
    });
    return dets.slice(0, maxBoxes).map((d) => ({
      class: COCO80[d.classIdx], score: d.score, bbox: d.bbox,
    }));
  }
}

export async function loadYolo(modelUrl, allowedClassNames) {
  ort.env.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.19.2/dist/";
  const session = await ort.InferenceSession.create(modelUrl, { executionProviders: ["wasm"] });
  return new YoloDetector(session, allowedClassNames);
}
