import { analyzeImage } from './vision.js';
import { sourceBlob } from './photo-assets.js';
import { isMobileRenderer } from './performance-profile.js';

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const yieldTask = () => new Promise(resolve => setTimeout(resolve, 0));

export function isVideoFile(file) {
  return /^video\//i.test(file.type) || /\.(mp4|m4v|mov|webm|ogv|3gp|3g2|mkv|avi)$/i.test(file.name || '');
}

function canvasAt(width, height, maxSide, read = false) {
  const canvas = document.createElement('canvas');
  const scale = Math.min(1, maxSide / Math.max(width, height));
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext('2d', {alpha:false, willReadFrequently:read});
  ctx.imageSmoothingQuality = 'high';
  return ctx;
}

// Blob playback and seeking use the device's native video decoder and its
// presentation dimensions (including rotation). Install listeners before seeking.
function mediaEvent(video, name, start, timeout = 9000) {
  return new Promise((resolve, reject) => {
    let timer;
    const clean = () => {
      clearTimeout(timer);
      video.removeEventListener(name, complete);
      video.removeEventListener('error', fail);
    };
    const complete = () => { clean(); resolve(); };
    const fail = () => { clean(); reject(new Error('This browser could not decode the video. Try H.264 MP4.')); };
    video.addEventListener(name, complete);
    video.addEventListener('error', fail);
    timer = setTimeout(fail, timeout);
    try { start(); } catch (error) { clean(); reject(error); }
  });
}

function seek(video, time) {
  if (!video.seeking && video.readyState >= 2 && Math.abs(time - video.currentTime) < .0001) return Promise.resolve();
  return mediaEvent(video, 'seeked', () => { video.currentTime = time; });
}

function readRGB(ctx, video) {
  const {width, height} = ctx.canvas;
  ctx.drawImage(video, 0, 0, width, height);
  const rgba = ctx.getImageData(0, 0, width, height).data;
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    rgb[j] = rgba[i]; rgb[j+1] = rgba[i+1]; rgb[j+2] = rgba[i+2];
  }
  return rgb;
}

function packDepth(profile, width, height) {
  const packed = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = Math.floor((x+.5)*profile.gridW/width) + profile.gridW*Math.floor((y+.5)*profile.gridH/height);
    packed[x+y*width] = profile.skyMask[i] ? 0 : Math.round(255 * profile.depth[i]);
  }
  return packed;
}

const colorBin = (rgb, i) => (rgb[i] >> 5)*64 + (rgb[i+1] >> 5)*8 + (rgb[i+2] >> 5);
const difference = (a, i, b, j) => Math.abs(a[i]-b[j]) + Math.abs(a[i+1]-b[j+1]) + Math.abs(a[i+2]-b[j+2]);

export function videoShotChange(a, b) {
  const histogram = new Int32Array(512);
  let delta = 0;
  for (let i = 0; i < a.length; i += 3) {
    histogram[colorBin(a,i)]++;
    histogram[colorBin(b,i)]--;
    delta += difference(a,i,b,i);
  }
  const distance = histogram.reduce((sum, n) => sum + Math.abs(n), 0) / (2*a.length/3);
  return distance > .55 && delta / a.length > 34;
}

function stillImage(a, b) {
  let changed=0;
  for(let i=0;i<a.length;i+=3) {
    if(difference(a,i,b,i)>24 && ++changed > a.length/3*.001) return false;
  }
  return true;
}

function holdStationarySurfaces(frame, anchor, width, height) {
  // Monocular models normalize depth independently on each frame. Lock parts
  // of the original view that are still visible to suppress scale breathing.
  const limit=width*height-1;
  for(let i=0;i<=limit;i++){
    if(difference(frame.rgb,3*i,anchor.rgb,3*i)>16)continue;
    const j=Math.min(limit,i+1), k=Math.min(limit,i+width);
    if(difference(frame.rgb,3*j,anchor.rgb,3*j)<18 && difference(frame.rgb,3*k,anchor.rgb,3*k)<18)
      frame.depth[i]=anchor.depth[i];
  }
}

// Fallback for a disoccluded surface or a shot without a nearby depth anchor.
function scenePrior(rgb, width, x, y, height) {
  const i=(x+y*width)*3, top=x*3;
  const horizon = .18 + .73*(y+.5)/height;
  const sky = y < .56*height && rgb[i+2] > rgb[i]*1.08 && difference(rgb,i,rgb,top) < 102;
  return sky ? 0 : Math.round(255*horizon);
}

export function propagateVideoDepth(prev, rgb, width, height, cut = false) {
  const out = new Uint8Array(width * height);
  if (cut) {
    for (let y=0; y<height; y++) for (let x=0; x<width; x++) out[x+y*width]=scenePrior(rgb,width,x,y,height);
    return out;
  }
  const old = prev.rgb, tile = 6;
  const cols = Math.ceil(width/tile), rows = Math.ceil(height/tile);
  const dx = new Int16Array(cols*rows), dy = new Int16Array(cols*rows);
  const reach = Math.min(18,Math.max(6,Math.round(Math.max(width,height)*.16)));
  const offset = (x,y) => (clamp(x,0,width-1) + clamp(y,0,height-1)*width)*3;
  for (let ty=0; ty<rows; ty++) for (let tx=0; tx<cols; tx++) {
    const x=Math.min(width-1,tx*tile+3), y=Math.min(height-1,ty*tile+3);
    let bx=0, by=0, score=Infinity;
    const consider = (mx,my) => {
      if (x+mx<0 || x+mx>=width || y+my<0 || y+my>=height) return;
      let error = .65*(Math.abs(mx)+Math.abs(my));
      for(let b=-2;b<=2;b+=2) for(let a=-2;a<=2;a+=2) {
        error += difference(rgb,offset(x+a,y+b),old,offset(x+a+mx,y+b+my));
        if(error>=score)return;
      }
      score=error; bx=mx; by=my;
    };
    consider(0,0);
    if(score>0){
      for(let my=-reach;my<=reach;my+=3) for(let mx=-reach;mx<=reach;mx+=3) consider(mx,my);
      const cx=bx,cy=by;
      for(let my=cy-2;my<=cy+2;my++) for(let mx=cx-2;mx<=cx+2;mx++) consider(mx,my);
    }
    dx[tx+ty*cols]=bx;dy[tx+ty*cols]=by;
  }
  // Resolve foreground edges per pixel. Flat backgrounds select zero motion;
  // adjacent patch vectors compete where a moving silhouette crosses a cell.
  const sums=new Float32Array(512),counts=new Uint32Array(512);
  for(let i=0;i<prev.depth.length;i++) {const b=colorBin(old,i*3);sums[b]+=prev.depth[i];counts[b]++;}
  for(let y=0;y<height;y++) for(let x=0;x<width;x++) {
    const i=x+y*width, p=i*3;
    let best=i,error=difference(rgb,p,old,p);
    if(error===0){out[i]=prev.depth[i];continue;}
    const left=clamp(Math.floor((x-3)/tile),0,cols-1),top=clamp(Math.floor((y-3)/tile),0,rows-1);
    for(let ty=top;ty<=Math.min(rows-1,top+1);ty++) for(let tx=left;tx<=Math.min(cols-1,left+1);tx++) {
      const k=tx+ty*cols, j=offset(x+dx[k],y+dy[k])/3;
      const cost=difference(rgb,p,old,j*3) + .15*(Math.abs(dx[k])+Math.abs(dy[k]));
      if(cost<error){best=j;error=cost;}
    }
    const bin=colorBin(rgb,p), fallback=counts[bin]?sums[bin]/counts[bin]:scenePrior(rgb,width,x,y,height);
    const trust=clamp(1-(error-20)/100,0,1);
    out[i]=Math.round(trust*prev.depth[best]+(1-trust)*fallback);
  }
  return out;
}

async function readClipFrames(video, ctx, duration, mobile, onProgress) {
  // Distribute the budget across the full clip. Slow random seeks reduce
  // density while retaining coverage of the tail of a long recording.
  const count=Math.min(mobile?36:60,Math.max(2,Math.ceil(duration*4)+1));
  const last=Math.max(0,duration-Math.min(.015,duration*.02));
  const frames=[{time:0,rgb:readRGB(ctx,video),cut:false}];
  const start=performance.now();
  for(let i=1;i<count;i++) {
    let time=last*i/(count-1);
    if(i>1){
      const elapsed=performance.now()-start, average=elapsed/(frames.length-1);
      const remaining=Math.max(1,Math.floor((11000-elapsed)/Math.max(8,average)));
      if(remaining<count-i){i=Math.min(count-1,i+Math.ceil((count-i)/remaining)-1);time=last*i/(count-1);}
    }
    onProgress?.('Reading video motion · '+Math.round(time/duration*100)+'%');
    try{await seek(video,time);}catch(error){if(frames.length===1)throw error;break;}
    const rgb=readRGB(ctx,video);
    frames.push({time,rgb,cut:videoShotChange(frames.at(-1).rgb,rgb)});
    await yieldTask();
  }
  return frames;
}

export async function prepareVideo(file, {onProgress, makeThumbnail}={}) {
  const mobile=isMobileRenderer(), url=URL.createObjectURL(file), clip=document.createElement('video');
  clip.muted=true;clip.defaultMuted=true;clip.playsInline=true;clip.preload='auto';
  let poster,grid;
  try{
    onProgress?.('Opening video');
    await mediaEvent(clip,'loadeddata',()=>{clip.src=url;clip.load();},15000);
    // MediaRecorder WebM files may omit duration until the decoder reaches EOF.
    if(!Number.isFinite(clip.duration)){await seek(clip,1e9);await seek(clip,0);}
    const {videoWidth:width,videoHeight:height,duration}=clip;
    if(!width||!height||!Number.isFinite(duration)||duration<=0)throw new Error('Choose a recorded video with a playable duration.');
    // loadeddata can precede the first composited picture. Seek within the
    // opening frame before sampling to avoid a black poster on phone decoders.
    await seek(clip,Math.min(.001,duration/4));
    poster=canvasAt(width,height,mobile?1280:2048);
    poster.drawImage(clip,0,0,poster.canvas.width,poster.canvas.height);
    const profile=await analyzeImage(poster.canvas,{originalWidth:width,originalHeight:height,onProgress});
    const thumb=makeThumbnail ? makeThumbnail(poster.canvas) : poster.canvas.toDataURL('image/jpeg',.78);
    profile.imageBlob=await sourceBlob(poster.canvas);profile.featureVersion=1;
    grid=canvasAt(width,height,mobile?92:124,true);
    const w=grid.canvas.width,h=grid.canvas.height;
    const frames=await readClipFrames(clip,grid,duration,mobile,onProgress);
    frames[0].depth=packDepth(profile,w,h);
    // Re-anchor a later shot to an independent monocular estimate when the
    // clip is long enough to accumulate tracking error. Track backwards from
    // that anchor as well so the approach to it remains continuous.
    let anchor=0;
    const stationary=frames.every(f=>stillImage(f.rgb,frames[0].rgb));
    if(!stationary&&duration>=1.2&&frames.length>=4){
      anchor=frames.findIndex((f,i)=>i>0&&f.cut);
      if(anchor<0)anchor=Math.round((frames.length-1)*.68);
      await seek(clip,frames[anchor].time);
      poster.drawImage(clip,0,0,poster.canvas.width,poster.canvas.height);
      onProgress?.('Estimating a second video depth field');
      const anchorProfile=await analyzeImage(poster.canvas,{originalWidth:width,originalHeight:height,onProgress});
      frames[anchor].depth=packDepth(anchorProfile,w,h);
    }
    for(let i=1;i<frames.length;i++) {
      if(stationary)frames[i].depth=frames[0].depth;
      else if(i!==anchor)frames[i].depth=propagateVideoDepth(frames[i-1],frames[i].rgb,w,h,frames[i].cut);
      await yieldTask();
    }
    if(anchor>1){
      let next=frames[anchor];
      for(let i=anchor-1;i>0&&!frames[i+1].cut;i--){
        const estimate=propagateVideoDepth(next,frames[i].rgb,w,h);
        next={rgb:frames[i].rgb,depth:estimate};
        const t=frames[i].time/frames[anchor].time, current=frames[i].depth;
        for(let j=0;j<current.length;j++)current[j]=Math.round(current[j]*(1-t)+estimate[j]*t);
        await yieldTask();
      }
    }
    if(!stationary) {
      let reference=frames[0];
      for(const frame of frames.slice(1)) {
        if(frame.cut)reference=frame;
        else holdStationarySurfaces(frame,reference,w,h);
      }
    }
    profile.video={id:crypto.randomUUID(),blob:file,duration,width,height,gridW:w,gridH:h,posterTime:0,frames};
    return {profile,thumb};
  }finally{
    clip.pause();clip.removeAttribute('src');clip.load();URL.revokeObjectURL(url);
    if(poster)poster.canvas.width=poster.canvas.height=1;
    if(grid)grid.canvas.width=grid.canvas.height=1;
  }
}
