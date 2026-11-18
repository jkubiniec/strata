import * as THREE from './vendor/three.module.js';
import {viewerAffinity} from './photo-motion.js';

const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
const wrap=(v,period)=>((v%period)+period)%period;
export const videoDisplacementLimit=42;

// Frames describe the same top-to-bottom UV grid as the original photo. A
// scene cut holds the preceding geometry until the new shot's actual timestamp.
export function temporalPair(frames, seconds) {
  let low=0,high=frames.length;
  while(low<high){
    const mid=(low+high)>>>1;
    if(frames[mid].time<=seconds)low=mid+1;else high=mid;
  }
  const a=clamp(low-1,0,frames.length-1),b=Math.min(a+1,frames.length-1);
  const phase=a===b||frames[b].cut?0:clamp((seconds-frames[a].time)/(frames[b].time-frames[a].time||1),0,1);
  return {a,b,mix:phase};
}

// Capture ray correspondence (UV + coverage) from the *fused* ray grid. A
// neighboring photo can own the shared block; its video still contributes.
export function videoSamples(grid) {
  const samples=[];
  if(!grid.maps||!grid.w||!grid.h)return samples;
  const w=Math.min(73,grid.w+1),h=Math.min(61,grid.h+1);
  for(const [index,record] of grid.neighbors.entries()){
    const clip=record.profile.video;
    if(!clip?.frames?.length)continue;
    const map=grid.maps[index],data=new Uint16Array(w*h*4);
    let maximum=0;
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){
      const k=(Math.round(x*grid.w/(w-1))+(grid.w+1)*Math.round(y*grid.h/(h-1)))*3;
      const i=(x+y*w)*4,weight=map[k+2];maximum=Math.max(maximum,weight);
      data[i]=THREE.DataUtils.toHalfFloat(map[k]*weight);
      data[i+1]=THREE.DataUtils.toHalfFloat(map[k+1]*weight);
      data[i+2]=THREE.DataUtils.toHalfFloat(weight);
    }
    if(maximum<.001)continue;
    const texture=new THREE.DataTexture(data,w,h,THREE.RGBAFormat,THREE.HalfFloatType);
    texture.minFilter=texture.magFilter=THREE.LinearFilter;texture.needsUpdate=true;
    samples.push({clip,record,texture,maximum});
  }
  return samples;
}

// Two independently clocked video observations can act on the same block.
// Compile sampler-free shaders for the much more common static photo layers.
export function videoUniforms(count){
  const uniforms={videoRemainderGain:{value:1}};
  for(let slot=0;slot<Math.min(2,count);slot++){
    for(const name of ['videoMap','videoReference','videoA','videoB','videoNative'])uniforms[name+slot]={value:null};
    for(const name of ['videoMix','videoUseNative','videoGain'])uniforms[name+slot]={value:0};
    uniforms['videoMapSize'+slot]={value:new THREE.Vector2(1,1)};
    uniforms['videoEye'+slot]={value:new THREE.Vector3()};
    uniforms['videoForward'+slot]={value:new THREE.Vector3()};
  }
  return uniforms;
}
const shaderSlot=i=>`
#if STRATA_VIDEO_SLOTS > ${i}
uniform sampler2D videoMap${i},videoReference${i},videoA${i},videoB${i},videoNative${i};
uniform vec2 videoMapSize${i};
uniform float videoMix${i},videoUseNative${i},videoGain${i};
uniform vec3 videoEye${i},videoForward${i};
vec3 videoObservation${i}(vec2 sourceUV){
  vec2 coords=(clamp(sourceUV,0.,1.)*(videoMapSize${i}-1.)+.5)/videoMapSize${i};
  vec3 observation=texture2D(videoMap${i},coords).xyz;
  observation.xy/=max(observation.z,.00001);
  observation.z=clamp(observation.z,0.,1.);
  return observation;
}
#ifdef STRATA_VIDEO_VERTEX
void videoMove${i}(vec3 p,vec2 st,inout vec3 delta,inout vec2 weights){
  if(videoGain${i}<=0.)return;
  vec3 s=videoObservation${i}(st);if(s.z<.001)return;
  float current=mix(texture2D(videoA${i},s.xy).a,texture2D(videoB${i},s.xy).a,videoMix${i});
  float reference=texture2D(videoReference${i},s.xy).a;
  float stepDepth=74.*(pow(max(0.,1.-current),1.48)-pow(max(0.,1.-reference),1.48));
  vec3 ray=p-videoEye${i};float z=dot(ray,videoForward${i});if(z<.1)return;
  float w=s.z*videoGain${i};
  // A foreground silhouette can uncover the far background in one frame.
  // Keep that occlusion change local rather than throwing one cube from a
  // nearby subject all the way to the sky. Small depth changes stay linear.
  float referenceDistance=14.+74.*pow(max(0.,1.-reference),1.48);
  float limit=clamp(referenceDistance*.38,7.,${videoDisplacementLimit}.);
  float excursion=stepDepth/max(1.,abs(stepDepth)/limit);
  delta+=ray/z*excursion*w;
  weights+=vec2(w,s.z);
}
#else
void videoPigment${i}(vec2 st,inout vec4 live,inout vec3 difference,inout vec2 weights){
  if(videoGain${i}<=0.)return;
  vec3 s=videoObservation${i}(st);if(s.z<.001)return;
  vec4 sampled=mix(texture2D(videoA${i},s.xy),texture2D(videoB${i},s.xy),videoMix${i});
  vec3 color=sampled.rgb;
  if(videoUseNative${i}>.5)color=texture2D(videoNative${i},s.xy).rgb;
  float w=s.z*videoGain${i};
  // At an overlap, near surfaces carry their contours further than distant
  // background. Concentrate the transition around those contours so two
  // unrelated landmarks do not persist as a uniform double exposure.
  float focus=w*w*exp2(3.*sampled.a);
  live+=vec4(color,1.)*focus;
  difference+=(color-texture2D(videoReference${i},s.xy).rgb)*w;
  weights+=vec2(w,s.z);
}
#endif
#endif`;
const slots='uniform float videoRemainderGain;\n'+shaderSlot(0)+shaderSlot(1);
export const videoVertexGL='#define STRATA_VIDEO_VERTEX\n'+slots+`
vec3 videoMovement(vec3 p,vec2 uv){
  vec3 delta=vec3(0.);vec2 weights=vec2(0.);
#if STRATA_VIDEO_SLOTS > 0
  videoMove0(p,uv,delta,weights);
#endif
#if STRATA_VIDEO_SLOTS > 1
  videoMove1(p,uv,delta,weights);
#endif
  delta/=max(.00001,weights.x+videoRemainderGain*max(0.,1.-weights.y));
  // Keep the static collision shell within interaction reach. The transition
  // band also prevents distant movie geometry sweeping through the camera.
  float range=length(p-cameraPosition);
  float strength=smoothstep(9.,16.,range)*min(1.,max(0.,range-9.)/max(.001,length(delta)));
  return delta*strength;
}`;
export const videoFragmentGL=slots+`
vec3 videoRadiance(vec2 uv,vec3 base, float phase){
  vec4 live=vec4(0.);vec3 difference=vec3(0.);vec2 weights=vec2(0.);
#if STRATA_VIDEO_SLOTS > 0
  videoPigment0(uv,live,difference,weights);
#endif
#if STRATA_VIDEO_SLOTS > 1
  videoPigment1(uv,live,difference,weights);
#endif
  if(weights.x<.00001)return base;
  // A fully filmed patch takes its actual current radiance. Adding a residual
  // to the first high-resolution poster would leave ghosts of moving subjects.
  vec3 mixed=base+difference/max(.00001,weights.x+videoRemainderGain*max(0.,1.-weights.y));
  float coverage=weights.x/max(.00001,weights.x+videoRemainderGain*max(0.,1.-weights.y));
  vec3 color=mix(mixed,live.rgb/max(.0000001,live.a),smoothstep(.72,.995,coverage));
  return mix(base,color,phase);
}`;

function frameTexture(frame,w,h){
  const data=new Uint8Array(w*h*4);
  const texture=new THREE.DataTexture(data,w,h);
  texture.minFilter=texture.magFilter=THREE.LinearFilter;
  texture.colorSpace=THREE.SRGBColorSpace;
  fillFrame(texture,frame);
  return texture;
}
function fillFrame(texture,frame){
  const data=texture.image.data;
  for(let i=0;i<frame.depth.length;i++){
    const p=4*i,k=3*i;
    data[p]=frame.rgb[k];data[p+1]=frame.rgb[k+1];data[p+2]=frame.rgb[k+2];data[p+3]=frame.depth[i];
  }
  texture.needsUpdate=true;
}
function ensureFrames(state,seconds){
  const clip=state.clip,frames=clip.frames;
  if(!state.textures){
    const make=()=>frameTexture(frames[0],clip.gridW,clip.gridH);
    state.textures={reference:make(),a:make(),b:make(),indexA:0,indexB:0};
  }
  const t=state.textures,pair=temporalPair(frames,seconds);
  if(t.indexA!==pair.a){fillFrame(t.a,frames[pair.a]);t.indexA=pair.a;}
  if(t.indexB!==pair.b){fillFrame(t.b,frames[pair.b]);t.indexB=pair.b;}
  state.mix=pair.mix;
}
function releaseNative(state){
  state.nativeReady=false;
  const player=state.native;if(!player)return;
  player.element.pause();player.element.removeAttribute('src');player.element.load();
  if(player.objectURL)URL.revokeObjectURL(player.objectURL);
  player.texture.dispose();player.canvas.width=player.canvas.height=1;
  state.native=null;
}
function releaseSource(state){
  releaseNative(state);
  const t=state.textures;if(t){t.reference.dispose();t.a.dispose();t.b.dispose();state.textures=null;}
}
function openNative(state,mobile){
  const clip=state.clip;
  if(state.failed||!globalThis.document||(!clip.blob&&!clip.url))return null;
  const element=document.createElement('video');
  element.playsInline=true;element.muted=true;element.defaultMuted=true;element.loop=true;element.preload='auto';
  const objectURL=clip.blob?URL.createObjectURL(clip.blob):null;
  const canvas=document.createElement('canvas');
  const scale=Math.min(1,(mobile?448:768)/Math.max(clip.width,clip.height));
  canvas.width=Math.max(1,Math.round(clip.width*scale));canvas.height=Math.max(1,Math.round(clip.height*scale));
  const context=canvas.getContext('2d',{alpha:false});
  if(!context){if(objectURL)URL.revokeObjectURL(objectURL);state.failed=true;return null;}
  const texture=new THREE.CanvasTexture(canvas);texture.flipY=false;texture.colorSpace=THREE.SRGBColorSpace;
  texture.minFilter=texture.magFilter=THREE.LinearFilter;texture.generateMipmaps=false;
  const native={element,canvas,context,texture,objectURL,stamp:-1,drawnAt:-Infinity,retryAt:0,synced:false};
  state.native=native;
  element.onerror=()=>{if(state.native===native)state.failed=true;};
  element.src=objectURL||clip.url;
  return native;
}
function updateNative(state,seconds,running,mobile,now){
  const native=state.native||openNative(state,mobile);if(!native)return false;
  const {element}=native;
  if(state.failed){releaseNative(state);return false;}
  if(element.readyState<1)return false;
  const tolerance=running ? .30 : .045;
  const difference=Math.abs(element.currentTime-seconds);
  if(!element.seeking&&(!native.synced||difference>tolerance)){
    native.synced=true;
    if(difference>.025){try{element.currentTime=seconds;}catch{return false;}}
  }
  if(running&&element.paused&&now>=native.retryAt){
    native.retryAt=now+1800;
    element.play()?.catch(()=>{});
  }else if(!running&&!element.paused)element.pause();
  if(element.readyState<2||element.seeking||Math.abs(element.currentTime-seconds)>tolerance)return false;
  if(native.stamp!==element.currentTime&&(!running||now-native.drawnAt>=1000/(mobile?24:30))){
    try{native.context.drawImage(element,0,0,native.canvas.width,native.canvas.height);}
    catch{state.failed=true;releaseNative(state);return false;}
    native.stamp=element.currentTime;native.drawnAt=now;native.texture.needsUpdate=true;
  }
  return native.stamp>=0;
}

export class VideoField {
  constructor(mobile=false){
    this.mobile=mobile;this.playing=true;this.suspended=false;this.sources=new Map();this.pendingSeeks=new Map();this.activeCount=0;
  }
  get hasActivePlayback(){return this.activeCount>0&&this.playing&&!this.suspended;}
  elapsed(state,now){
    const delta=this.playing&&!this.suspended?Math.max(0,now-state.started)/1000:0;
    return wrap(state.base+delta,state.clip.duration);
  }
  time(id){const state=this.sources.get(id);return state?this.elapsed(state,performance.now()):this.pendingSeeks.get(id)||0;}
  setClock(flag,value){
    value=!!value;if(value===this[flag])return;
    const now=performance.now();
    for(const state of this.sources.values()){
      state.base=this.elapsed(state,now);state.started=now;
      if(state.native){state.native.element.pause();state.native.retryAt=0;}
    }
    this[flag]=value;
  }
  setPlaying(value){this.setClock('playing',value);}
  setSuspended(value){this.setClock('suspended',value);}
  seek(id,seconds){
    if(!Number.isFinite(seconds))return;
    const state=this.sources.get(id);
    if(!state){this.pendingSeeks.set(id,Math.max(0,seconds));return;}
    state.base=clamp(seconds,0,Math.max(0,state.clip.duration-.001));state.started=performance.now();
    if(state.native)state.native.synced=false;
  }
  update(atlas,camera,now=performance.now()){
    if(this.suspended)return;
    const visible=[],priorities=new Map(),eye=camera.position,affinities=new Map();
    const affinityOf=record=>{
      if(!affinities.has(record))affinities.set(record,viewerAffinity(eye,record.motionSite||record.s));
      return affinities.get(record);
    };
    // Register all placements, including invisible ones: a clip shares one
    // clock across placements and resumes at the correct time on returning.
    for(const record of atlas.stamps){
      const clip=record.profile.video;if(!clip?.frames?.length||this.sources.has(clip.id))continue;
      const base=clamp(this.pendingSeeks.get(clip.id)||0,0,Math.max(0,clip.duration-.001));
      this.sources.set(clip.id,{clip,base,started:now,lastSeen:now});this.pendingSeeks.delete(clip.id);
    }
    if(!this.sources.size)return;
    const layers=atlas.stamps.map(r=>r.layer).concat(atlas.retiring);
    for(const layer of layers){
      if(!layer?.root.visible||!layer.videoSamples?.length)continue;
      const ranked=layer.videoSamples.map(sample=>{
        const affinity=affinityOf(sample.record);
        const priority=sample.maximum*Math.pow(affinity,.34);
        return {sample,priority};
      }).sort((a,b)=>b.priority-a.priority);
      // A distant film still animates its own surface, even when two closer
      // neighbors outrank it. Coverage in its UV map gates it per pixel.
      // Phone chooses from all neighbors within its shared four-source budget.
      const candidates=this.mobile?ranked:ranked.slice(0,2);
      if(!this.mobile && layer.ownVideoSample && ranked.length>2){
        const own=ranked.find(entry=>entry.sample===layer.ownVideoSample);
        if(own && !candidates.includes(own))candidates[1]=own;
      }
      for(const {sample,priority} of candidates){
        const id=sample.clip.id;
        priorities.set(id,Math.max(priorities.get(id)||0,priority));
      }
      visible.push({layer,ranked:candidates});
    }
    const preferred=atlas.stamps[atlas.preferredCapture],clip=preferred?.profile.video;
    if(clip && this.sources.has(clip.id) && Math.hypot(eye.x-preferred.s.x,eye.y-preferred.s.y,eye.z-preferred.s.z)<2)
      priorities.set(clip.id,Math.max(2,priorities.get(clip.id)||0));
    const byPriority=[...priorities].sort((a,b)=>b[1]-a[1]);
    const live=new Set((this.mobile?byPriority.slice(0,4):byPriority).map(([id])=>id));
    // Avoid bouncing one hardware decoder between nearly tied sources as the
    // viewer walks along their boundary. All samples still share their clocks.
    const decoderRank=byPriority.filter(([id])=>live.has(id)).map(([id,score])=>
      [id,score*(this.sources.get(id)?.native?1.15:1)]).sort((a,b)=>b[1]-a[1]);
    const decoded=new Set(decoderRank.slice(0,this.mobile?2:4).map(([id])=>id));
    this.activeCount=live.size;
    for(const [id,state] of this.sources){
      if(!live.has(id)){
        if(state.native)releaseNative(state);
        if(now-state.lastSeen>1500)releaseSource(state);
        continue;
      }
      state.lastSeen=now;
      const seconds=this.elapsed(state,now);ensureFrames(state,seconds);
      if(decoded.has(id))state.nativeReady=updateNative(state,seconds,this.playing,this.mobile,now);
      else releaseNative(state);
    }
    for(const {layer,ranked} of visible){
      const choices=ranked.filter(({sample})=>live.has(sample.clip.id)).slice(0,2);
      const u=layer.uniforms;
      let remainder=0;
      for(const observer of layer.videoObservers){
        if(choices.every(({sample})=>sample.record!==observer))remainder=Math.max(remainder,affinityOf(observer));
      }
      const strongest=Math.max(1e-20,remainder,...choices.map(({sample})=>affinityOf(sample.record)));
      u.videoRemainderGain.value=Math.pow(remainder/strongest,.8);
      for(let slot=0;slot<Math.min(2,ranked.length);slot++){
        const selected=choices[slot];
        if(!selected){
          u['videoGain'+slot].value=0;
          for(const name of ['videoMap','videoReference','videoA','videoB','videoNative'])u[name+slot].value=null;
          continue;
        }
        const {sample}=selected,state=this.sources.get(sample.clip.id),t=state.textures;
        const capture=sample.record.s;
        u['videoMap'+slot].value=sample.texture;
        u['videoMapSize'+slot].value.set(sample.texture.image.width,sample.texture.image.height);
        u['videoEye'+slot].value.set(capture.x,capture.y,capture.z);
        u['videoForward'+slot].value.set(capture.dx,capture.dy,capture.dz);
        u['videoReference'+slot].value=t.reference;u['videoA'+slot].value=t.a;u['videoB'+slot].value=t.b;
        u['videoNative'+slot].value=state.nativeReady?state.native.texture:t.a;
        u['videoUseNative'+slot].value=state.nativeReady?1:0;u['videoMix'+slot].value=state.mix;
        u['videoGain'+slot].value=Math.pow(affinityOf(sample.record)/strongest,.8);
      }
    }
  }
  dispose(){for(const state of this.sources.values())releaseSource(state);this.sources.clear();this.pendingSeeks.clear();this.activeCount=0;}
}
