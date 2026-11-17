/* Depth Anything V2 Small, quantized ONNX export. See NOTICE.txt. */
import * as ort from './ort.wasm.min.mjs';

ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;
ort.env.wasm.wasmPaths = new URL('./', import.meta.url).href;
ort.env.logLevel = 'error';

async function loadModel() {
  const parts = await Promise.all([1, 2].map(async part => {
    const response = await fetch(`depth-v2-small.${part}.bin`);
    if (!response.ok) throw new Error('Depth weights unavailable');
    return new Uint8Array(await response.arrayBuffer());
  }));
  const model = new Uint8Array(parts[0].length + parts[1].length);
  model.set(parts[0]);
  model.set(parts[1], parts[0].length);
  return ort.InferenceSession.create(model, { executionProviders: ['wasm'], executionMode: 'sequential', graphOptimizationLevel: 'all' });
}

self.onmessage = async ({ data: { rgba, width, height } }) => {
  let session;
  try {
    session = await loadModel();
    self.postMessage({ phase: 'Estimating depth with Depth Anything V2' });
    const pixels = width * height, input = new Float32Array(pixels * 3);
    const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
    for (let c = 0; c < 3; c++) {
      const scale = 1 / (255 * std[c]), shift = mean[c] / std[c];
      for (let i = 0; i < pixels; i++) input[c * pixels + i] = rgba[i * 4 + c] * scale - shift;
    }
    const tensor = new ort.Tensor('float32', input, [1, 3, height, width]);
    const result = await session.run({ [session.inputNames[0]]: tensor });
    const output = result[session.outputNames[0]];
    const raw = await output.getData();
    const ordered = raw.slice().sort();
    const near = ordered[Math.floor((ordered.length - 1) * 0.99)], far = ordered[Math.floor(ordered.length * 0.01)];
    if (!Number.isFinite(far) || !Number.isFinite(near) || near - far < 1e-6) throw new Error('Insufficient depth variation');
    const values = new Uint16Array(raw.length);
    for (let i = 0; i < raw.length; i++) values[i] = Math.round(Math.max(0, Math.min(1, (raw[i] - far) / (near - far))) * 65535);
    const [h, w] = output.dims.slice(-2);
    self.postMessage({ w, h, values }, [values.buffer]);
  } catch (error) {
    self.postMessage({ error: String(error.message || error) });
  } finally {
    await session?.release();
  }
};
