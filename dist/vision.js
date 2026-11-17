import { refineryFeatures } from './photo-assets.js';
const clamp = (value, low = 0, high = 1) => Math.min(high, Math.max(low, value));
const detectorSize = 416;
let detectorWorker;
let inferenceId = 0;
const waiting = new Map();

function closeDetector(error) {
  detectorWorker?.terminate();
  detectorWorker = undefined;
  for (const task of waiting.values()) task.reject(error);
  waiting.clear();
}

function workerForDetection() {
  if (detectorWorker) return detectorWorker;
  const worker = new Worker(new URL('./vendor/vision/detector.js?v=2.1', import.meta.url));
  worker.onmessage = ({ data }) => {
    const task = waiting.get(data.id);
    if (!task) return;
    waiting.delete(data.id);
    if (data.error) task.reject(new Error(data.error));
    else task.resolve({detections:data.detections, photoFeatures:data.photoFeatures});
  };
  worker.onerror = event => closeDetector(new Error(event.message || 'Detector unavailable'));
  worker.onmessageerror = () => closeDetector(new Error('Detector response unreadable'));
  detectorWorker = worker;
  return worker;
}

function makeCanvas(w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  return ctx;
}

export async function detectObjects(image, width = image.naturalWidth || image.width, height = image.naturalHeight || image.height) {
  const scale = detectorSize / Math.max(width, height);
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const x = Math.floor((detectorSize - w) / 2), y = Math.floor((detectorSize - h) / 2);
  const ctx = makeCanvas(detectorSize, detectorSize);
  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, detectorSize, detectorSize);
  ctx.fillStyle = '#e4dfd1';
  ctx.fillRect(x, y, w, h);
  ctx.drawImage(image, x, y, w, h);
  const rgba = ctx.getImageData(0, 0, detectorSize, detectorSize).data;
  const worker = workerForDetection();
  const id = ++inferenceId;
  let watchdog;
  try {
    return await new Promise((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      watchdog = setTimeout(() => closeDetector(new Error('Detector timed out')), 45000);
      worker.postMessage({ id, rgba, viewport: { x, y, w, h } }, [rgba.buffer]);
    });
  } finally {
    clearTimeout(watchdog);
    waiting.delete(id);
    if (!waiting.size && worker === detectorWorker) {
      // Release detector weights and its WASM heap before the depth pass or gameplay.
      worker.terminate();
      detectorWorker = undefined;
    }
  }
}

function sampleImage(image, w, h) {
  const ctx = makeCanvas(w, h);
  ctx.fillStyle = '#e4dfd1';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(image, 0, 0, w, h);
  const rgba = ctx.getImageData(0, 0, w, h).data;
  const n = w * h;
  const rgb = new Uint8Array(n * 3), luma = new Float32Array(n), edge = new Float32Array(n);
  let seed = 2166136261, greenery = 0, gray = 0;
  for (let i = 0; i < n; i++) {
    const j = i * 4, k = i * 3;
    const r = rgb[k] = rgba[j], g = rgb[k + 1] = rgba[j + 1], b = rgb[k + 2] = rgba[j + 2];
    luma[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    greenery += g > 1.025 * r && g > 1.095 * b && g - b > 8 ? 1 : 0;
    gray += Math.max(r, g, b) - Math.min(r, g, b) < 35 ? 1 : 0;
    seed = Math.imul(seed ^ ((r << 16) | (g << 8) | b), 16777619);
  }
  let strong = 0, aligned = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const dx = Math.abs(luma[i + 1] - luma[i - 1]);
    const dy = Math.abs(luma[i + w] - luma[i - w]);
    const magnitude = dx + dy;
    edge[i] = magnitude;
    if (magnitude > 24) {
      strong++;
      aligned += Math.min(dx, dy) < 0.32 * Math.max(dx, dy) ? 1 : 0;
    }
  }
  return { rgb, luma, edge, seed: seed >>> 0, greenery: greenery / n, gray: gray / n,
    texture: strong / n, aligned: aligned / Math.max(1, strong) };
}

// Flood from the top of the photo so a blue shirt or a reflection remains a surface.
function skyFromBorders(s, w, h) {
  const n = w * h, sky = new Uint8Array(n), allowed = new Uint8Array(n), queue = new Int32Array(n);
  const { rgb, luma, edge } = s;
  const prototypes = [];
  for (let c = 0; c < 14; c++) {
    const px = Math.min(w - 1, Math.floor((c + 0.5) * w / 14));
    const i = Math.min(h - 1, Math.round(h * 0.015)) * w + px, k = i * 3;
    if (edge[i] < 30 && luma[i] > 57) prototypes.push([rgb[k], rgb[k + 1], rgb[k + 2]]);
  }
  let tail = 0, front = 0, blueCount = 0;
  for (let y = 0; y < Math.ceil(h * 0.84); y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, k = i * 3, r = rgb[k], g = rgb[k + 1], b = rgb[k + 2];
    const veg = g > b * 1.105 && g > r * 1.015 && g - b > 8;
    const blue = b >= g * 0.94 && b > r + 9 && g > r * 0.97;
    const cloud = Math.max(r, g, b) - Math.min(r, g, b) < 37 && luma[i] > 100;
    const warm = r > b + 12 && r >= g * 0.97 && luma[i] > 115 && y / h < 0.63;
    if (veg || !(blue || cloud || warm) || edge[i] > (blue ? 51 : 36)) continue;
    const known = blue || prototypes.some(p => Math.abs(r - p[0]) + Math.abs(g - p[1]) + Math.abs(b - p[2]) < 137);
    if (!known) continue;
    allowed[i] = blue ? 2 : 1;
    if (y === 0) { sky[i] = 1; queue[tail++] = i; }
  }
  const add = (neighbor, from) => {
    if (!allowed[neighbor] || sky[neighbor] || Math.abs(luma[neighbor] - luma[from]) > 29) return;
    sky[neighbor] = 1;
    queue[tail++] = neighbor;
  };
  while (front < tail) {
    const i = queue[front++], x = i % w;
    if (allowed[i] === 2) blueCount++;
    if (x > 0) add(i - 1, i);
    if (x + 1 < w) add(i + 1, i);
    if (i >= w) add(i - w, i);
    if (i + w < n) add(i + w, i);
  }
  const boundary = new Float32Array(w);
  const silhouette = new Float32Array(w);
  let columns = 0;
  for (let x = 0; x < w; x++) {
    for (let y = Math.ceil(h * 0.84) - 1; y >= 0; y--) {
      if (sky[y * w + x]) { boundary[x] = (y + 1) / h; break; }
    }
    if (boundary[x] > 0.10) columns++;
    let y = 0;
    while (y < h && sky[y * w + x]) y++;
    silhouette[x] = y / h;
  }
  const supportsSky = columns > w * 0.30 && tail > n * 0.035;
  if (!supportsSky) sky.fill(0);
  const ordered = boundary.slice().sort();
  // Count narrow projections which rise appreciably above both neighboring rooflines.
  let spires = 0, run = 0;
  const radius = Math.max(2, Math.round(w * 0.072)), gap = Math.max(1, Math.round(w * 0.012));
  if (supportsSky) for (let x = radius; x < w - radius; x++) {
    let left = 0, right = 0;
    for (let j = gap; j <= radius; j += 2) {
      left = Math.max(left, silhouette[x - j]); right = Math.max(right, silhouette[x + j]);
    }
    if (Math.min(left, right) - silhouette[x] > 0.10 && silhouette[x] > 0.045) run++;
    else {
      if (run >= w * 0.004 && run < w * 0.075) spires++;
      run = 0;
    }
  }
  return { mask: sky, fraction: supportsSky ? tail / n : 0, blue: supportsSky ? blueCount / n : 0,
    spires, horizon: supportsSky ? clamp(ordered[Math.floor(0.82 * (w - 1))] + 0.055, 0.22, 0.78) : 0.46 };
}

const indoor = new Set(['couch', 'bed', 'dining table', 'toilet', 'tv', 'laptop', 'keyboard', 'microwave', 'oven', 'toaster', 'sink', 'refrigerator']);
const vehicles = new Set(['car', 'truck', 'bus', 'motorcycle', 'train', 'traffic light', 'stop sign', 'parking meter', 'fire hydrant']);
function sceneKind(s, sky, detections, starter) {
  if (starter) return 'industrial';
  const largest = detections.reduce((best, box) => (box.w * box.h > (best ? best.w * best.h : 0) ? box : best), undefined);
  if (detections.some(d => indoor.has(d.label) && d.score > 0.42) && sky.blue < 0.16) return 'interior';
  if (largest && largest.w * largest.h > 0.36 && !vehicles.has(largest.label)) return 'object';
  const subjects = detections.filter(d => {
    const cx = d.x + d.w / 2, cy = d.y + d.h / 2;
    return !vehicles.has(d.label) && d.score > 0.38 && cx > 0.15 && cx < 0.85 && cy > 0.2 && cy < 0.87;
  }).sort((a, b) => b.w * b.h - a.w * a.h);
  const first = subjects[0] ? subjects[0].w * subjects[0].h : 0;
  const second = subjects[1] ? subjects[1].w * subjects[1].h : 0;
  const traffic = detections.reduce((m, d) => vehicles.has(d.label) ? Math.max(m, d.w * d.h) : m, 0);
  if (sky.fraction < 0.28 && first > 2 * traffic && (first > 0.25 || (first > 0.14 && second > 0.1 && first + second > 0.32))) return 'object';
  const railContext = detections.some(d => d.label === 'train');
  if (sky.spires >= (railContext ? 2 : 4) && s.gray > 0.35 && s.aligned > 0.53 && s.texture > 0.13) return 'industrial';
  if (sky.fraction > 0.56 && sky.blue < 0.05 && s.texture < 0.15) return 'object';
  if (detections.some(d => vehicles.has(d.label)) && (s.gray > 0.25 || detections.length > 1)) return 'urban';
  if (s.greenery > 0.34 || (s.greenery > 0.21 && sky.fraction < 0.18 && s.texture > 0.2)) return 'woodland';
  if (sky.fraction > 0.06) {
    if (s.aligned > 0.51 && s.texture > 0.135 && s.gray > 0.31) return 'urban';
    return 'landscape';
  }
  if (largest && largest.w * largest.h > 0.12) return 'object';
  if (s.aligned > 0.56 && s.texture > 0.14 && s.gray > 0.23) return 'interior';
  if (s.greenery > 0.11 || s.texture > 0.29) return 'landscape';
  return 'object';
}

// Color-connected regions provide a common contact depth for parts of upright structures.
// Edges are bucket-sorted, then merged using the internal color variation of each region.
function colorRegions(s, w, h, sky) {
  const n = w * h, { rgb } = s;
  const parent = new Int32Array(n), size = new Uint32Array(n), cost = new Float32Array(n);
  const last = new Int32Array(256).fill(-1), next = new Int32Array(2 * n);
  const lowY = new Uint16Array(n), highY = new Uint16Array(n), ave = new Float32Array(n);
  const root = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  function insert(i, neighbor, key) {
    if (sky[i] !== sky[neighbor]) return;
    const a = i * 3, b = neighbor * 3;
    const distance = Math.min(255, Math.round(0.29 * Math.abs(rgb[a] - rgb[b]) + 0.46 * Math.abs(rgb[a + 1] - rgb[b + 1]) + 0.25 * Math.abs(rgb[a + 2] - rgb[b + 2])));
    next[key] = last[distance]; last[distance] = key;
  }
  for (let i = 0; i < n; i++) {
    parent[i] = i; size[i] = 1; cost[i] = 41;
    if (i % w) insert(i, i - 1, i * 2);
    if (i >= w) insert(i, i - w, i * 2 + 1);
  }
  for (let d = 0; d < last.length; d++) for (let k = last[d]; k >= 0; k = next[k]) {
    const a = k >> 1, b = a - ((k & 1) ? w : 1);
    let p = root(a), q = root(b);
    if (p === q || d > Math.min(cost[p], cost[q])) continue;
    if (size[p] < size[q]) [p, q] = [q, p];
    parent[q] = p; size[p] += size[q]; cost[p] = d + 41 / size[p];
  }
  lowY.fill(h);
  for (let i = 0; i < n; i++) {
    const p = parent[i] = root(i), y = Math.floor(i / w);
    lowY[p] = Math.min(lowY[p], y); highY[p] = Math.max(highY[p], y); ave[p] += s.luma[i];
  }
  for (let i = 0; i < n; i++) if (parent[i] === i) ave[i] /= size[i];
  return { parent, size, lowY, highY, ave };
}

function relativeDepth(s, w, h, sky, kind, detections) {
  const n = w * h, depth = new Float32Array(n), { rgb, luma, edge } = s;
  const objectScene = kind === 'object', inside = kind === 'interior';
  const outdoor = !objectScene && !inside;
  const horizon = sky.horizon;
  const regions = colorRegions(s, w, h, sky.mask);
  // On a perspective ground plane inverse distance increases toward the camera.
  const plane = v => 0.10 + 0.82 * Math.pow(clamp((v - horizon) / Math.max(0.16, 1 - horizon)), 0.94);
  for (let i = 0; i < n; i++) {
    const y = (Math.floor(i / w) + 0.5) / h, x = (i % w + 0.5) / w, k = i * 3;
    if (sky.mask[i]) { depth[i] = 0.012 + 0.026 * y; continue; }
    const p = regions.parent[i], height = (regions.highY[p] - regions.lowY[p]) / h;
    const localContrast = clamp((regions.ave[p] - luma[i]) / 120, -1, 1);
    const texture = Math.tanh(edge[i] / 65), shade = (155 - luma[i]) / 255;
    const green = clamp((rgb[k + 1] - (rgb[k] * 0.48 + rgb[k + 2] * 0.52)) / 46);
    const area = regions.size[p] / n, center = 1 - clamp(Math.hypot((x - 0.5) * 1.48, (y - 0.52) * 1.45));
    let d;
    if (outdoor) {
      const foot = (regions.highY[p] + 0.5) / h;
      const support = clamp((height - 0.035) * 4.2) * (1 - clamp((area - 0.035) * 6));
      d = plane(y) + (plane(foot) - plane(y)) * support * 0.86;
      d += 0.095 * shade + 0.095 * green + 0.06 * texture + 0.038 * localContrast;
      if (kind === 'woodland') d += 0.06 * center + 0.05 * green;
    } else if (inside) {
      const wallPerspective = Math.max(Math.abs(x - 0.5) * 1.5, Math.abs(y - 0.42));
      d = 0.16 + 0.48 * wallPerspective + 0.24 * y * y + shade * 0.17 + 0.08 * texture + 0.05 * localContrast;
    } else {
      d = 0.13 + 0.43 * center + 0.14 * y + 0.22 * shade + 0.085 * texture + 0.06 * localContrast;
    }
    depth[i] = clamp(d, 0.055, 0.97);
  }
  // Elliptical falloff keeps a detector box's corners from imprinting on the relief.
  for (const box of detections) {
    const left = Math.floor(box.x * w), top = Math.floor(box.y * h);
    const right = Math.min(w, Math.ceil((box.x + box.w) * w)), bottom = Math.min(h, Math.ceil((box.y + box.h) * h));
    const base = outdoor ? plane(box.y + box.h) : 0.43 + 0.34 * Math.sqrt(box.w * box.h);
    for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
      const i = y * w + x;
      if (sky.mask[i]) continue;
      const u = (2 * ((x + 0.5) / w - box.x) / box.w) - 1;
      const v = (2 * ((y + 0.5) / h - box.y) / box.h) - 1;
      const insideBox = clamp((1 - (u * u * 0.85 + v * v * 0.82)) * 2.2);
      const raised = base + 0.075 * insideBox + 0.045 * (1 - luma[i] / 255);
      depth[i] += Math.max(0, raised - depth[i]) * insideBox * box.score;
    }
  }
  // A small bilateral filter suppresses noisy pixel relief while retaining silhouettes.
  const smooth = depth.slice();
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    if (sky.mask[i]) continue;
    let sum = depth[i] * 2, weights = 2;
    for (const j of [i - w, i + w, i - 1, i + 1]) {
      if (sky.mask[j]) continue;
      const weight = 1 / (1 + Math.abs(luma[i] - luma[j]) / 10);
      sum += weight * depth[j]; weights += weight;
    }
    smooth[i] = clamp(sum / weights);
  }
  return smooth;
}

// Weighted median-cut palette. Working on a compact histogram keeps the partition
// proportional to visible color area even when large photos contain millions of colors.
function extractPalette(rgb) {
  const bins = new Map();
  const step = Math.max(1, Math.floor(rgb.length / (3 * 22000)));
  for (let i = 0; i < rgb.length; i += 3 * step) {
    const r = rgb[i], g = rgb[i + 1], b = rgb[i + 2];
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    let bin = bins.get(key);
    if (!bin) { bin = [0, 0, 0, 0]; bins.set(key, bin); }
    bin[0] += r; bin[1] += g; bin[2] += b; bin[3]++;
  }
  function box(values) {
    let count = 0;
    const min = [255, 255, 255], max = [0, 0, 0];
    for (const b of values) {
      count += b[3];
      for (let c = 0; c < 3; c++) { min[c] = Math.min(min[c], b[c]); max[c] = Math.max(max[c], b[c]); }
    }
    const spans = max.map((v, c) => v - min[c]);
    const axis = spans.indexOf(Math.max(...spans));
    return { values, count, axis, priority: values.length > 1 ? spans[axis] * Math.sqrt(count) : 0 };
  }
  const colors = [...bins.values()];
  for (const c of colors) for (let i = 0; i < 3; i++) c[i] /= c[3];
  const boxes = [box(colors)];
  while (boxes.length < 6) {
    boxes.sort((a, b) => b.priority - a.priority);
    if (boxes[0].priority === 0) break;
    const { values, count, axis } = boxes.shift();
    values.sort((a, b) => a[axis] - b[axis]);
    let weight = 0, cut = 0;
    while (cut < values.length - 1 && weight < count / 2) weight += values[cut++][3];
    boxes.push(box(values.slice(0, cut)), box(values.slice(cut)));
  }
  return boxes.map(({ values, count }) => {
    const avg = [0, 0, 0];
    for (const b of values) for (let c = 0; c < 3; c++) avg[c] += b[c] * b[3] / count;
    return avg;
  }).sort((a, b) => (0.299 * (a[0] - b[0]) + 0.587 * (a[1] - b[1]) + 0.114 * (a[2] - b[2])))
    .map(c => '#' + c.map(v => Math.round(v).toString(16).padStart(2, '0')).join(''));
}

async function runDepthModel(image, width, height, onProgress) {
  if (typeof WebAssembly === 'undefined') throw new Error('WebAssembly unavailable');
  if (width < 2 || height < 2) throw new Error('A single pixel row or column has no two-dimensional structure');
  const memory = navigator.deviceMemory || (navigator.hardwareConcurrency <= 4 || matchMedia('(pointer: coarse)').matches ? 4 : 6);
  const maxSide = memory <= 2 ? 224 : memory <= 4 ? 308 : width * height >= 4000000 ? 448 : 392;
  const scale = maxSide / Math.max(width, height);
  const w = Math.max(56, Math.round(width * scale / 14) * 14);
  const h = Math.max(56, Math.round(height * scale / 14) * 14);
  // Maintain the photographed proportions when an extremely thin frame is narrower
  // than the transformer's minimum useful input. Extend its edge pixels into the padding.
  const cw = width * scale < 56 ? Math.max(1, Math.round(width * scale)) : w;
  const ch = height * scale < 56 ? Math.max(1, Math.round(height * scale)) : h;
  const left = Math.floor((w - cw) / 2), top = Math.floor((h - ch) / 2);
  const ctx = makeCanvas(w, h);
  ctx.fillStyle = '#e4dfd1';
  ctx.fillRect(0, 0, w, h);
  if (cw < w) {
    if (left) ctx.drawImage(image, 0, 0, 1, height, 0, 0, left, h);
    ctx.drawImage(image, width - 1, 0, 1, height, left + cw, 0, w - left - cw, h);
  } else if (ch < h) {
    if (top) ctx.drawImage(image, 0, 0, width, 1, 0, 0, w, top);
    ctx.drawImage(image, 0, height - 1, width, 1, 0, top + ch, w, h - top - ch);
  }
  ctx.drawImage(image, left, top, cw, ch);
  const rgba = ctx.getImageData(0, 0, w, h).data;
  const worker = new Worker(new URL('./vendor/vision/depth.js', import.meta.url), { type: 'module' });
  let timer;
  try {
    return await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Depth model timed out')), 80000);
      worker.onerror = e => reject(new Error(e.message || 'Depth worker unavailable'));
      worker.onmessageerror = () => reject(new Error('Depth result unreadable'));
      worker.onmessage = ({ data }) => {
        if (data.phase) onProgress?.(data.phase);
        else if (data.error) reject(new Error(data.error));
        else resolve({ ...data, viewport: { x: left / w, y: top / h, w: cw / w, h: ch / h } });
      };
      worker.postMessage({ rgba, width: w, height: h }, [rgba.buffer]);
    });
  } finally {
    clearTimeout(timer);
    // Discard the transformer session and its large WASM heap before rendering the region.
    worker.terminate();
  }
}

async function storedStarterAnalysis() {
  const response = await fetch(new URL('./vendor/vision/refinery-depth.bin', import.meta.url));
  if (!response.ok) throw new Error('Stored refinery analysis unavailable');
  const bytes = await response.arrayBuffer(), header = new DataView(bytes);
  const w = header.getUint16(0, true), h = header.getUint16(2, true);
  if (w !== 518 || h !== 350 || bytes.byteLength !== 4 + 2 * w * h) throw new Error('Unexpected refinery analysis');
  // Original detector output on assets/refinery.jpg, alongside its precomputed depth.
  const detections = [{ label: 'train', x: 0.01262167, y: 0.66430765, w: 0.34172511, h: 0.12133890, score: 0.43791778 }];
  return { depth: { w, h, values: new Uint16Array(bytes, 4) }, detections, photoFeatures: await refineryFeatures() };
}

function applyMonocularDepth(depth, sky, w, h, map) {
  const values = map.values;
  const view = map.viewport || { x: 0, y: 0, w: 1, h: 1 };
  for (let y = 0; y < h; y++) {
    const sy = clamp((view.y + (y + 0.5) * view.h / h) * map.h - 0.5, 0, map.h - 1), y0 = Math.floor(sy), y1 = Math.min(y0 + 1, map.h - 1);
    const fy = sy - y0;
    for (let x = 0; x < w; x++) {
      const sx = clamp((view.x + (x + 0.5) * view.w / w) * map.w - 0.5, 0, map.w - 1), x0 = Math.floor(sx), x1 = Math.min(x0 + 1, map.w - 1);
      const fx = sx - x0, i = y * w + x;
      const a = (1 - fx) * values[y0 * map.w + x0] + fx * values[y0 * map.w + x1];
      const b = (1 - fx) * values[y1 * map.w + x0] + fx * values[y1 * map.w + x1];
      const d = ((1 - fy) * a + fy * b) / 65535;
      if (d > 0.12) sky[i] = 0;
      depth[i] = sky[i] ? d * 0.5 : clamp(0.96 * d + 0.04 * depth[i]);
    }
  }
}

export async function analyzeImage(image, { starter = false, onProgress } = {}) {
  const width = image.naturalWidth || image.width, height = image.naturalHeight || image.height;
  if (!(width > 0 && height > 0)) throw new Error('The photo has no readable pixels.');
  onProgress?.(starter ? 'Reading the refinery photo study' : 'Reading objects with Tiny YOLOv3');
  let stored;
  if (starter && width === 6000 && height === 4000) {
    try { stored = await storedStarterAnalysis(); } catch { /* Recompute if cached assets are unavailable. */ }
  }
  const objectTask = stored ? Promise.resolve(stored) : detectObjects(image, width, height);
  const learned = objectTask.then(result => ({ ...result, available: true }), error => {
    console.warn('Using local image analysis without object detections.', error.message);
    return { detections: [], available: false };
  });
  const long = Math.max(width, height);
  const target = Math.min(long, 600, Math.round(42 + 6.45 * Math.sqrt(long)));
  const gridW = Math.max(1, Math.round(width * target / long)), gridH = Math.max(1, Math.round(height * target / long));
  const detail = clamp(Math.log2(1 + Math.sqrt(width * height) / 96) / 5.75);
  const signals = sampleImage(image, gridW, gridH);
  const sky = skyFromBorders(signals, gridW, gridH);
  const palette = extractPalette(signals.rgb);
  const { detections, photoFeatures, available } = await learned;
  const kind = sceneKind(signals, sky, detections, starter);
  if (kind === 'interior' || (kind === 'object' && (sky.blue < 0.1 || sky.fraction > 0.53))) { sky.mask.fill(0); sky.horizon = 0.46; }
  onProgress?.(stored ? 'Placing photo surfaces' : 'Loading the local depth model');
  await new Promise(resolve => setTimeout(resolve, 0));
  const modelDepth = stored ? Promise.resolve(stored.depth) : runDepthModel(image, width, height, onProgress).catch(error => {
    console.warn('Using color and edge depth cues.', error.message);
    return undefined;
  });
  const depth = relativeDepth(signals, gridW, gridH, sky, kind, detections);
  const map = await modelDepth;
  if (map) applyMonocularDepth(depth, sky.mask, gridW, gridH, map);
  return { width, height, gridW, gridH, rgb: signals.rgb, depth, skyMask: sky.mask, palette, kind,
    seed: signals.seed, detail, detections, photoFeatures, visionLabel: available ? 'Tiny YOLOv3' : 'Color and edge analysis',
    depthLabel: map ? 'Depth Anything V2 Small' : 'Color and edge depth cues' };
}
