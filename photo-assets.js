// Study files store a short JSON header followed by compact typed-array payloads.
async function readStudy(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('Could not load the local photo study.');
  const buffer = await res.arrayBuffer();
  const end = 4 + new DataView(buffer).getUint32(0, true);
  const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, end - 4)));
  return {meta, buffer, offset:end};
}

export async function sampleProfile(name) {
  const {meta, buffer, offset} = await readStudy('./assets/'+name+'-study.bin');
  const {featureShape, ...profile} = meta;
  const n = profile.gridW * profile.gridH;
  const bytes = new Uint8Array(buffer);
  profile.rgb = bytes.subarray(offset, offset + 3*n);
  profile.skyMask = bytes.subarray(offset + 3*n, offset + 4*n);
  const depth = new DataView(buffer, offset + 4*n, 2*n);
  profile.depth = Float32Array.from({length:n}, (_,i) => depth.getUint16(i*2, true) / 65535);
  profile.photoFeatures = {...featureShape, values:new Int8Array(buffer, offset + 6*n)};
  profile.imageURL = './assets/'+name+'.jpg';
  return profile;
}


export async function expressProfile() {
  const [profile, study, response] = await Promise.all([
    sampleProfile('express'), readStudy('./assets/express-motion.bin'), fetch('./assets/express.mp4')
  ]);
  if (!response.ok) throw new Error('Could not open the train film.');
  const {meta, buffer} = study;
  const n = meta.gridW * meta.gridH;
  let offset = study.offset;
  const frames = meta.frames.map(frame => {
    const rgb = new Uint8Array(buffer, offset, n*3);
    const depth = new Uint8Array(buffer, offset+n*3, n);
    offset += n*4;
    return {...frame,rgb,depth};
  });
  profile.video = {...meta,frames,blob:await response.blob()};
  return profile;
}

async function isPhoneHEIF(file) {
  if (/^image\/hei[cf](?:-sequence)?$/i.test(file.type) || /\.hei[cf]s?$/i.test(file.name)) return true;
  const bytes = new Uint8Array(await file.slice(0, 64).arrayBuffer());
  const header = new TextDecoder('latin1').decode(bytes);
  if (header.slice(4, 8) !== 'ftyp') return false;
  const brands = [header.slice(8, 12)];
  for (let i = 16; i + 4 <= header.length; i += 4) brands.push(header.slice(i, i + 4));
  if (brands.includes('avif') || brands.includes('avis')) return false;
  return brands.some(brand => ['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(brand));
}

async function convertHEIF(file, maxEdge) {
  const worker = new Worker(new URL('./heic-worker.js', import.meta.url));
  try {
    const result = await new Promise((resolve, reject) => {
      worker.onmessage = event => event.data.error ? reject(new Error(event.data.error)) : resolve(event.data);
      worker.onerror = event => reject(new Error(event.message || 'The HEIF decoder could not start.'));
      worker.postMessage({file, maxEdge: Math.min(3072, maxEdge)});
    });
    const image = document.createElement('canvas');
    image.width = result.w;
    image.height = result.h;
    image.getContext('2d').putImageData(new ImageData(result.pixels, result.w, result.h), 0, 0);
    return {image, width: result.width, height: result.height, release: () => { image.width = image.height = 1; }};
  } finally {
    worker.terminate();
  }
}

// Use the browser's oriented image dimensions, including portrait phone photos.
// Release the full-size decode before the vision workers allocate their heaps.
export async function importPixels(file, maxEdge) {
  const url = URL.createObjectURL(file);
  const original = new Image();
  original.decoding = 'async';
  original.src = url;
  try {
    try {
      await original.decode();
    } catch (decodeError) {
      if (!await isPhoneHEIF(file)) throw decodeError;
      original.removeAttribute('src');
      return await convertHEIF(file, maxEdge);
    }
    const width = original.naturalWidth, height = original.naturalHeight;
    const scale = Math.min(1, maxEdge / Math.max(width, height));
    if (scale === 1) return { image: original, width, height, release: () => original.removeAttribute('src') };
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext('2d', {alpha:false});
    ctx.fillStyle = '#e4dfd1';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(original, 0, 0, canvas.width, canvas.height);
    original.removeAttribute('src');
    return { image: canvas, width, height, release: () => { canvas.width = canvas.height = 1; } };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function sourceBlob(img) {
  const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
  const scale = Math.min(1, 3072 / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w*scale));
  canvas.height = Math.max(1, Math.round(h*scale));
  const context = canvas.getContext('2d', {alpha:false});
  context.fillStyle = '#e4dfd1';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.imageSmoothingQuality = 'high';
  context.drawImage(img, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve,reject) => canvas.toBlob(blob => {
    canvas.width = canvas.height = 1;
    if (blob) resolve(blob);
    else reject(new Error('Could not store the photograph texture.'));
  }, 'image/webp', .94));
}
