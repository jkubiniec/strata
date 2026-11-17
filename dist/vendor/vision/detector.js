/* Tiny YOLOv3 inference for the official Darknet COCO model. See NOTICE.txt. */
'use strict';
importScripts('tf-core.min.js', 'tf-backend-wasm.min.js');

const inputSize = 416;
const channels = [
  [3, 16, 3], [16, 32, 3], [32, 64, 3], [64, 128, 3],
  [128, 256, 3], [256, 512, 3], [512, 1024, 3], [1024, 256, 1],
  [256, 512, 3], [512, 255, 1], [256, 128, 1], [384, 256, 3], [256, 255, 1]
];
const labels = 'person,bicycle,car,motorcycle,airplane,bus,train,truck,boat,traffic light,fire hydrant,stop sign,parking meter,bench,bird,cat,dog,horse,sheep,cow,elephant,bear,zebra,giraffe,backpack,umbrella,handbag,tie,suitcase,frisbee,skis,snowboard,sports ball,kite,baseball bat,baseball glove,skateboard,surfboard,tennis racket,bottle,wine glass,cup,fork,knife,spoon,bowl,banana,apple,sandwich,orange,broccoli,carrot,hot dog,pizza,donut,cake,chair,couch,potted plant,bed,dining table,toilet,tv,laptop,mouse,remote,keyboard,cell phone,microwave,oven,toaster,sink,refrigerator,book,clock,vase,scissors,teddy bear,hair drier,toothbrush'.split(',');
const anchors = [[10, 14], [23, 27], [37, 58], [81, 82], [135, 169], [344, 319]];
const clamp01 = x => Math.max(0, Math.min(1, x));
const sigmoid = x => 1 / (1 + Math.exp(-x));
let inferenceSize = inputSize;
let backend;

async function startBackend() {
  try {
    tf.env().set('WASM_HAS_MULTITHREAD_SUPPORT', false);
    tf.wasm.setThreadsCount(1);
    tf.wasm.setWasmPaths(new URL('./', self.location.href).href);
    if (await tf.setBackend('wasm')) return true;
  } catch { /* The browser may disable WebAssembly. */ }
  importScripts('tf-backend-cpu.min.js');
  inferenceSize = 288;
  return tf.setBackend('cpu');
}

async function loadNetwork() {
  backend ||= startBackend();
  const [ready, response] = await Promise.all([backend, fetch('yolov3-tiny.q8.bin')]);
  if (!ready || !response.ok) throw new Error('The local detector could not load.');
  const buffer = await response.arrayBuffer();
  let offset = 0;
  const layers = channels.map(([inputs, outputs, size]) => {
    const bias = tf.tensor1d(new Float32Array(buffer, offset, outputs));
    offset += outputs * 4;
    const scale = new Float32Array(buffer, offset, outputs);
    offset += outputs * 4;
    const count = inputs * outputs * size * size;
    const codes = new Int8Array(buffer, offset, count);
    offset += count;
    const values = new Float32Array(count);
    for (let base = 0; base < count; base += outputs) {
      for (let i = 0; i < outputs; i++) values[base + i] = codes[base + i] * scale[i];
    }
    return { bias, kernel: tf.tensor4d(values, [size, size, inputs, outputs]) };
  });
  if (offset !== buffer.byteLength) throw new Error('Unexpected detector weights.');
  return layers;
}

// A sign-scrambled Hadamard projection compresses the 256 learned
// activations at every image patch. All photographs share the same basis.
function patchDescriptors(features, viewport) {
  const [, side, , sourceChannels] = features.shape;
  const width = Math.max(1, Math.round(side * viewport.w / inputSize));
  const height = Math.max(1, Math.round(side * viewport.h / inputSize));
  const channels = 32;
  const values = new Int8Array(width * height * channels);
  const raw = features.dataSync(), projected = new Float32Array(sourceChannels);
  const signs = new Int8Array(sourceChannels);
  let seed = 12854233;
  for (let c = 0; c < sourceChannels; c++) {
    seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
    signs[c] = seed >>> 31 ? 1 : -1;
  }
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const gx = Math.min(side - 1, Math.floor(side * (viewport.x + (x + .5) * viewport.w / width) / inputSize));
    const gy = Math.min(side - 1, Math.floor(side * (viewport.y + (y + .5) * viewport.h / height) / inputSize));
    const base = (gy * side + gx) * sourceChannels;
    for (let c = 0; c < sourceChannels; c++) {
      const value = raw[base + c];
      projected[c] = signs[c] * Math.sign(value) * Math.sqrt(Math.abs(value));
    }
    for (let stride = 1; stride < sourceChannels; stride *= 2) {
      for (let i = 0; i < sourceChannels; i += 2 * stride) for (let j = i; j < i + stride; j++) {
        const a = projected[j], b = projected[j + stride];
        projected[j] = a + b;
        projected[j + stride] = a - b;
      }
    }
    let norm = 0;
    for (let c = 0; c < channels; c++) norm += projected[c * 7] ** 2;
    const scale = 127 / Math.sqrt(norm || 1);
    for (let c = 0; c < channels; c++) values[(y * width + x) * channels + c] = Math.round(projected[c * 7] * scale);
  }
  return { width, height, channels, values };
}

function infer(layers, rgba, viewport) {
  const input = new Float32Array(inputSize * inputSize * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4) {
    input[j++] = rgba[i] / 255;
    input[j++] = rgba[i + 1] / 255;
    input[j++] = rgba[i + 2] / 255;
  }
  const conv = (x, index, linear = false) => tf.tidy(() => {
    const { kernel, bias } = layers[index];
    const activation = tf.add(tf.conv2d(x, kernel, 1, 'same'), bias);
    return linear ? activation : tf.leakyRelu(activation, 0.1);
  });
  return tf.tidy(() => {
    let x = tf.tensor4d(input, [1, inputSize, inputSize, 3]);
    if (inferenceSize !== inputSize) x = tf.image.resizeBilinear(x, [inferenceSize, inferenceSize]);
    for (let stage = 0; stage < 4; stage++) x = tf.maxPool(conv(x, stage), 2, 2, 'same');
    const fine = conv(x, 4);
    x = conv(tf.maxPool(fine, 2, 2, 'same'), 5);
    x = conv(tf.maxPool(x, 2, 1, 'same'), 6);
    const coarse = conv(x, 7);
    const head13 = conv(conv(coarse, 8), 9, true);
    const up = tf.image.resizeNearestNeighbor(conv(coarse, 10), [fine.shape[1], fine.shape[2]]);
    const head26 = conv(conv(tf.concat([up, fine], 3), 11), 12, true);
    return { heads: [head13.dataSync(), head26.dataSync()], photoFeatures: patchDescriptors(fine, viewport) };
  });
}

function decode(heads, viewport) {
  const candidates = [];
  for (let head = 0; head < heads.length; head++) {
    const side = inferenceSize / (head === 0 ? 32 : 16);
    const data = heads[head];
    for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) for (let a = 0; a < 3; a++) {
      const start = ((y * side + x) * 3 + a) * 85;
      const objectness = sigmoid(data[start + 4]);
      if (objectness < 0.29) continue;
      let bestClass = 0;
      for (let k = 1; k < 80; k++) if (data[start + 5 + k] > data[start + 5 + bestClass]) bestClass = k;
      const score = objectness * sigmoid(data[start + 5 + bestClass]);
      if (score < 0.29) continue;
      const [aw, ah] = anchors[a + (head === 0 ? 3 : 0)];
      const cx = ((x + sigmoid(data[start])) * inputSize / side - viewport.x) / viewport.w;
      const cy = ((y + sigmoid(data[start + 1])) * inputSize / side - viewport.y) / viewport.h;
      const halfW = Math.exp(data[start + 2]) * aw / viewport.w * 0.5 * inputSize / inferenceSize;
      const halfH = Math.exp(data[start + 3]) * ah / viewport.h * 0.5 * inputSize / inferenceSize;
      const left = clamp01(cx - halfW), top = clamp01(cy - halfH);
      const w = clamp01(cx + halfW) - left, h = clamp01(cy + halfH) - top;
      if (w > 0.008 && h > 0.008) candidates.push({ label: labels[bestClass], x: left, y: top, w, h, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const selected = [];
  for (const a of candidates) {
    const duplicate = selected.some(b => {
      if (a.label !== b.label) return false;
      const w = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
      const h = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
      const overlap = w * h;
      return overlap / (a.w * a.h + b.w * b.h - overlap) > 0.42;
    });
    if (!duplicate) selected.push(a);
    if (selected.length >= 40) break;
  }
  return selected;
}

let network;
self.onmessage = async ({ data }) => {
  try {
    network ||= loadNetwork();
    const {heads, photoFeatures} = infer(await network, data.rgba, data.viewport);
    self.postMessage({ id: data.id, detections: decode(heads, data.viewport), photoFeatures }, [photoFeatures.values.buffer]);
  } catch (error) {
    network = undefined;
    self.postMessage({ id: data.id, error: String(error.message || error) });
  }
};
