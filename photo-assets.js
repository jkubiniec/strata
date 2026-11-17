// Study files store a short JSON header followed by compact typed-array payloads.
async function readStudy(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('Could not load the local photo study.');
  const buffer = await res.arrayBuffer();
  const end = 4 + new DataView(buffer).getUint32(0, true);
  const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, end - 4)));
  return {meta, buffer, offset:end};
}

export async function refineryFeatures() {
  const {meta, buffer, offset} = await readStudy('./assets/refinery-features.bin');
  return {...meta, values:new Int8Array(buffer, offset)};
}

export async function sampleProfile(name='launch') {
  const {meta, buffer, offset} = await readStudy('./assets/'+name+'-study.bin');
  const {featureShape, ...profile} = meta;
  const n = profile.gridW * profile.gridH;
  const bytes = new Uint8Array(buffer);
  profile.rgb = bytes.subarray(offset, offset + 3*n);
  profile.skyMask = bytes.subarray(offset + 3*n, offset + 4*n);
  const depth = new DataView(buffer, offset + 4*n, 2*n);
  profile.depth = Float32Array.from({length:n}, (_,i) => depth.getUint16(i*2, true) / 65535);
  profile.photoFeatures = {...featureShape, values:new Int8Array(buffer, offset + 6*n)};
  profile.imageURL = './assets/'+name+(name==='astronaut'?'.png':'.jpg');
  return profile;
}
export const launchProfile = () => sampleProfile('launch');

export function sourceBlob(img) {
  const scale = Math.min(1, 3072 / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.naturalWidth*scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight*scale));
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
