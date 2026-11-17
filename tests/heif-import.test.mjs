import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';

test('HEIC worker decodes the primary still and transfers only its scaled pixels', async () => {
  const require = createRequire(new URL('../dist/heic-worker.js', import.meta.url));
  const worker = { self: {}, Uint8Array, Uint8ClampedArray };
  worker.importScripts = path => { worker.libheif = require(path); };
  const code = await readFile(new URL('../dist/heic-worker.js', import.meta.url), 'utf8');
  vm.runInNewContext(code, worker);
  // 32 × 24 derivative of the public-domain Delicate Arch photo in dist/assets/walk.
  const file = new Blob([await readFile(new URL('./fixtures/arch-32x24.heic', import.meta.url))]);
  const result = await new Promise(resolve => {
    worker.self.postMessage = (message, transferred) => resolve({message, transferred});
    worker.self.onmessage({data: {file, maxEdge: 16}});
  });
  const {message, transferred} = result;
  assert.equal(message.error, undefined);
  assert.deepEqual([message.width, message.height, message.w, message.h], [32, 24, 16, 12]);
  assert.equal(transferred[0], message.pixels.buffer);
  assert.equal(message.pixels.length, 16 * 12 * 4);
  assert.ok(new Set(message.pixels).size > 50);
  assert.equal(message.pixels[3], 255);
});
