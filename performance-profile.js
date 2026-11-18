// Touch laptops with a primary mouse keep desktop rendering. iPadOS can
// present a desktop user agent, including when a trackpad is attached.
export function isMobileRenderer() {
  const query=new URLSearchParams(globalThis.location?.search);
  if(query.get('demo')==='phone'||query.get('platform')==='phone')return true;
  const nav=globalThis.navigator;
  if(!nav)return false;
  return /iPhone|iPad|iPod/i.test(nav.userAgent||'') ||
    (nav.platform==='MacIntel'&&nav.maxTouchPoints>1) ||
    (nav.maxTouchPoints>0&&globalThis.matchMedia?.('(pointer: coarse)').matches===true);
}

export const phoneBudget=Object.freeze({
  pixelRatio:1.05, rasterPixels:490000, minPixelRatio:.62,
  chunkRadius:4, chunkMillis:3, textureSide:576, sourceSide:768,
  cacheBytes:12*1024*1024, visibleTexels:1550000, rayScale:.68,
  motionWidth:33, motionHeight:29
});

export const desktopBudget=Object.freeze({
  pixelRatio:1.65, rasterPixels:2700000, chunkRadius:7,
  textureSide:1410, sourceSide:1536, cacheBytes:36*1024*1024,
  visibleTexels:6291456, rayScale:1, motionWidth:51, motionHeight:45
});

// Pixels follow sustained frame pressure during play. Give a fast phone
// several seconds of headroom before restoring detail after a heavy patch.
export class AdaptiveRaster {
  constructor(){this.scale=1;this.seconds=0;this.frames=0;this.fastSeconds=0;}
  observe(seconds){
    if(seconds<=0||seconds>.4){this.seconds=this.frames=this.fastSeconds=0;return false;}
    this.seconds+=seconds;this.frames++;
    if(this.seconds<1.3||this.frames<6)return false;
    const mean=this.seconds/this.frames,old=this.scale;
    if(mean>.037){
      this.scale=Math.max(phoneBudget.minPixelRatio,this.scale-.10);this.fastSeconds=0;
    }else if(mean<.022){
      this.fastSeconds+=this.seconds;
      if(this.fastSeconds>5){this.scale=Math.min(1,this.scale+.06);this.fastSeconds=0;}
    }else this.fastSeconds=0;
    this.seconds=this.frames=0;
    return old!==this.scale;
  }
}
