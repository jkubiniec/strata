// Legacy browsers that cannot open a phone HEIC run this decoder in a disposable worker.
importScripts('./vendor/heif/libheif-bundle.js');

self.onmessage = async ({data: {file, maxEdge}}) => {
  try {
    const codec = await libheif();
    const decoder = new codec.HeifDecoder();
    const images = decoder.decode(new Uint8Array(await file.arrayBuffer()));
    const primary = images.find(image => image.is_primary()) || images[0];
    if (!primary) throw new Error('The HEIF file contains no readable photo.');
    const decoded = await codec.heif_js_decode_image2(primary.handle,
      codec.heif_colorspace.heif_colorspace_RGB, codec.heif_chroma.heif_chroma_interleaved_RGBA);
    const channel = decoded.channels?.find(item => item.id === codec.heif_channel.heif_channel_interleaved);
    if (!channel?.width || !channel.height) throw new Error('The HEIF primary image could not be decoded.');
    // Read the codec-owned buffer directly. Only the scaled image crosses to the game.
    const {width, height, stride, data: rgba} = channel;
    const scale = Math.min(1, maxEdge / Math.max(width, height));
    const w = Math.max(1, Math.round(width * scale)), h = Math.max(1, Math.round(height * scale));
    const pixels = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      if (w === width && h === height) {
        pixels.set(rgba.subarray(y * stride, y * stride + w * 4), y * w * 4);
        continue;
      }
      const sy = Math.min(height - 1, (y + .5) * height / h - .5);
      const row = Math.floor(sy) * stride, next = Math.min(height - 1, Math.floor(sy) + 1) * stride;
      const fy = sy - Math.floor(sy);
      for (let x = 0; x < w; x++) {
        const sx = Math.min(width - 1, (x + .5) * width / w - .5);
        const left = Math.floor(sx) * 4, right = Math.min(width - 1, Math.floor(sx) + 1) * 4;
        const fx = sx - Math.floor(sx), offset = 4 * (y * w + x);
        for (let k = 0; k < 4; k++) {
          const top = rgba[row + left + k] * (1 - fx) + rgba[row + right + k] * fx;
          const bottom = rgba[next + left + k] * (1 - fx) + rgba[next + right + k] * fx;
          pixels[offset + k] = top * (1 - fy) + bottom * fy;
        }
      }
    }
    codec.heif_image_release(decoded.image);
    for (const image of images) image.free();
    self.postMessage({width, height, w, h, pixels}, [pixels.buffer]);
  } catch(error) {
    self.postMessage({error: error?.message || 'Could not read this HEIF photograph.'});
  }
};
