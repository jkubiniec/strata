// A stamp is a camera observation in one world coordinate system. Its
// projection is immutable. The cube lattice belongs to the world, never to
// a camera or to a pair of successive images.
import * as THREE from './vendor/three.module.js';
import { desktopBudget } from './performance-profile.js';
import {projectionUniforms,surfaceProjectionGL} from './terrain-projection.js';
import { photoDistance } from './world.js';
import { fuseAppearance } from './photo-fusion.js?v=3.5';
import { beginFusion } from './fusion-task.js';
import { correspondence } from './morph.js';
import { buildPhotoMotion, zeroMotionTexture, motionLimit, motionSite, viewerAffinity } from './photo-motion.js';
import {videoSamples,videoUniforms,videoVertexGL,videoFragmentGL,videoDisplacementLimit} from './video-field.js';

const clamp=(v,a=0,b=1)=>Math.max(a,Math.min(b,v));
const mix=(a,b,t)=>a+(b-a)*t;
const smooth=(a,b,v)=>{const t=clamp((v-a)/(b-a));return t*t*(3-2*t);};
const MAX_DEPTH=98;
const section=32;
const key=(x,y,z)=>x+','+y+','+z;

export function cameraStamp(input) {
  if(Number.isFinite(input.slopeX) && Number.isFinite(input.uz))return input;
  const eye=input.eye??input, yaw=input.yaw||0,pitch=input.pitch||0;
  const ca=Math.cos(yaw),sa=Math.sin(yaw),ce=Math.cos(pitch),se=Math.sin(pitch);
  const fov=input.fov||65,aspect=input.aspect||1,sy=2*Math.tan(fov*Math.PI/360);
  return {...input,x:eye.x,y:eye.y,z:eye.z,eye:{x:eye.x,y:eye.y,z:eye.z},yaw,pitch,fov,aspect,
    dx:sa*ce,dy:se,dz:-ca*ce,rx:ca,ry:0,rz:sa,ux:-sa*se,uy:ce,uz:ca*se,
    slopeX:sy*aspect,slopeY:sy,offsetX:0,offsetY:0,near:input.near??.07,far:input.far??600};
}
export function captureStamp(camera) {
  camera.updateWorldMatrix(true,false);
  const m=camera.matrixWorld.elements,p=camera.projectionMatrix.elements;
  const x=m[12],y=m[13],z=m[14],dx=-m[8],dy=-m[9],dz=-m[10];
  return {x,y,z,eye:{x,y,z},yaw:Math.atan2(dx,-dz),pitch:Math.asin(clamp(dy,-1,1)),
    dx,dy,dz,rx:m[0],ry:m[1],rz:m[2],ux:m[4],uy:m[5],uz:m[6],
    slopeX:2/p[0],slopeY:2/p[5],offsetX:p[8]/p[0],offsetY:p[9]/p[5],
    aspect:p[5]/p[0],fov:2*Math.atan(1/p[5])*180/Math.PI,near:camera.near,far:camera.far};
}
function project(s,x,y,z,out) {
  const ox=x-s.x,oy=y-s.y,oz=z-s.z;
  const d=ox*s.dx+oy*s.dy+oz*s.dz;
  out.d=d;
  out.u=.5+((ox*s.rx+oy*s.ry+oz*s.rz)/(d||1e-9)-(s.offsetX||0))/s.slopeX;
  out.v=.5-((ox*s.ux+oy*s.uy+oz*s.uz)/(d||1e-9)-(s.offsetY||0))/s.slopeY;
  out.inside=d>=s.near&&d<=s.far&&out.u>=0&&out.u<=1&&out.v>=0&&out.v<=1;
  return out;
}
export function projectStamp(stamp,x,y,z){return project(cameraStamp(stamp),x,y,z,{});}
function back(s,u,v,d,out) {
  const h=(u-.5)*s.slopeX+(s.offsetX||0),k=(.5-v)*s.slopeY+(s.offsetY||0);
  out.x=s.x+d*(s.dx+h*s.rx+k*s.ux);out.y=s.y+d*(s.dy+h*s.ry+k*s.uy);out.z=s.z+d*(s.dz+h*s.rz+k*s.uz);
  return out;
}
export function unprojectStamp(stamp,u,v,d){return back(cameraStamp(stamp),u,v,d,{});}
export function stampBounds(stamp,limit=Infinity) {
  const s=cameraStamp(stamp),b={minX:Infinity,minY:Infinity,minZ:Infinity,maxX:-Infinity,maxY:-Infinity,maxZ:-Infinity},p={};
  for(const d of [s.near,Math.min(Math.max(s.near,limit),s.far)])for(const v of [0,1])for(const u of [0,1]){
    back(s,u,v,d,p);
    b.minX=Math.min(b.minX,p.x);b.minY=Math.min(b.minY,p.y);b.minZ=Math.min(b.minZ,p.z);
    b.maxX=Math.max(b.maxX,p.x);b.maxY=Math.max(b.maxY,p.y);b.maxZ=Math.max(b.maxZ,p.z);
  }
  return b;
}
function intersects(a,b){return a.minX<=b.maxX&&a.maxX>=b.minX&&a.minY<=b.maxY&&a.maxY>=b.minY&&a.minZ<=b.maxZ&&a.maxZ>=b.minZ;}
function indexAt(profile,u,v){
  return clamp(Math.floor(u*profile.gridW),0,profile.gridW-1)+profile.gridW*clamp(Math.floor(v*profile.gridH),0,profile.gridH-1);
}
function photoUV(r,u,v,out) {out.u=.5+(u-.5)*r.cropX;out.v=.5+(v-.5)*r.cropY;return out;}
function rawDepth(r,u,v) {
  const i=indexAt(r.profile,u,v);
  return r.profile.skyMask?.[i]?Math.min(r.s.far-.05,MAX_DEPTH):clamp(photoDistance(r.profile.depth[i]||0),r.s.near+.10,r.s.far-.05);
}
function confidence(u,v) {
  const margin=Math.min(u,1-u,v,1-v);
  return smooth(0,.14,margin)*Math.exp(-4.2*((u-.5)**2+(v-.5)**2));
}
function observationWeight(q) {
  // Angularly broad distant observations cover much more world space per
  // pixel. A closer camera resolves the same surface with a smaller footprint.
  const footprint=1+Math.max(0,q.d)/23;
  return confidence(q.u,q.v)/(footprint*footprint);
}
function uvWarp(flow,u,v,out) {
  const x=clamp(u)*(flow.cols-1),y=clamp(v)*(flow.rows-1);
  const i=Math.min(flow.cols-2,Math.floor(x)),j=Math.min(flow.rows-2,Math.floor(y));
  const fx=x-i,fy=y-j,k=2*(i+flow.cols*j),stride=flow.cols*2,a=flow.uv;
  out.u=mix(mix(a[k],a[k+2],fx),mix(a[k+stride],a[k+stride+2],fx),fy);
  out.v=mix(mix(a[k+1],a[k+3],fx),mix(a[k+stride+1],a[k+stride+3],fx),fy);
}
function canShare(a,b) {
  if(!intersects(a.bounds,b.bounds))return false;
  // Exact signed-plane rejection of A's eight corners by any B plane, then
  // vice versa. Opposite cameras sharing an eye have disjoint open volumes.
  function excludes(p,q){
    const corners=[];
    for(const d of [p.s.near,Math.min(MAX_DEPTH+3,p.s.far)])for(const v of [0,1])for(const u of [0,1]){
      const k=back(p.s,u,v,d,{}),s=q.s;
      const ox=k.x-s.x,oy=k.y-s.y,oz=k.z-s.z,depth=ox*s.dx+oy*s.dy+oz*s.dz;
      const x=ox*s.rx+oy*s.ry+oz*s.rz-depth*(s.offsetX||0), y=ox*s.ux+oy*s.uy+oz*s.uz-depth*(s.offsetY||0);
      corners.push([depth-s.near,Math.min(MAX_DEPTH+3,s.far)-depth,depth*s.slopeX*.5+x,depth*s.slopeX*.5-x,depth*s.slopeY*.5+y,depth*s.slopeY*.5-y]);
    }
    return corners[0].some((_,i)=>corners.every(c=>c[i]<=.00001));
  }
  return !excludes(a,b)&&!excludes(b,a);
}

async function sourcePixels(profile,maxSide) {
  const compact={width:profile.gridW,height:profile.gridH,data:profile.rgb,stride:3};
  if(typeof document==='undefined' || (!profile.imageBlob&&!profile.imageURL))return compact;
  let image=null,url=null;
  try{
    image=new Image();
    url=profile.imageBlob?URL.createObjectURL(profile.imageBlob):null;image.src=url||profile.imageURL;await image.decode();
    const size=Math.min(1,maxSide/Math.max(image.naturalWidth,image.naturalHeight));
    const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(image.naturalWidth*size));canvas.height=Math.max(1,Math.round(image.naturalHeight*size));
    const ctx=canvas.getContext('2d',{willReadFrequently:true,colorSpace:'srgb'});ctx.drawImage(image,0,0,canvas.width,canvas.height);
    return {width:canvas.width,height:canvas.height,data:ctx.getImageData(0,0,canvas.width,canvas.height).data,stride:4};
  }catch{return compact;}finally{if(url)URL.revokeObjectURL(url);}
}
function lookup(p,u,v) {
  return (clamp((u*p.width)|0,0,p.width-1)+clamp((v*p.height)|0,0,p.height-1)*p.width)*p.stride;
}
function blockId(r,g,b){
  if(g>r*1.12 && g>b*1.11)return g>124?1:7;
  if(r>b*1.29&&r>g*1.14)return r>150?6:4;
  return Math.max(r,g,b)-Math.min(r,g,b)<26&&r>156?3:5;
}
function textureOf(image){
  const texture=new THREE.DataTexture(image.data,image.width,image.height,THREE.RGBAFormat);
  texture.colorSpace=THREE.SRGBColorSpace;texture.minFilter=THREE.LinearMipmapLinearFilter;texture.magFilter=THREE.LinearFilter;
  texture.generateMipmaps=true;texture.needsUpdate=true;return texture;
}
function makeRayGrid(r) {
  const s=r.s,maxSide=Math.round(116+54*(r.profile.detail??.55));
  // Oversample wide apertures to cover each unit cube even on distant layers.
  const scale=r.budget?.rayScale??1;
  const w=clamp(scale*Math.max(maxSide*Math.min(1,s.aspect),Math.min(275,MAX_DEPTH*s.slopeX*1.18)),32,275)|0;
  const h=clamp(scale*Math.max(maxSide/Math.max(1,s.aspect),Math.min(225,MAX_DEPTH*s.slopeY*1.18)),32,225)|0;
  const neighbors=[r,...r.neighbors],maps=neighbors.map(()=>new Float32Array((w+1)*(h+1)*3));
  const depths=new Float32Array((w+1)*(h+1)),skies=new Uint8Array(depths.length),owned=new Uint8Array(depths.length);
  const probes=neighbors.map(()=>({u:0,v:0,d:0,inside:false,su:0,sv:0,w:0})),point={},mapped={},tuv={},rootUV={};
  for(let j=0;j<=h;j++)for(let i=0;i<=w;i++){
    const pos=i+j*(w+1),u=i/w,v=j/h;
    photoUV(r,u,v,rootUV);
    let d=rawDepth(r,rootUV.u,rootUV.v),sky=0;
    for(let step=0;step<3;step++){
      back(s,u,v,d,point);let sum=0;
      for(let k=0;k<neighbors.length;k++){
        const f=neighbors[k],q=probes[k];
        project(f.s,point.x,point.y,point.z,q);
        if(k===0){q.u=u;q.v=v;q.d=d;q.inside=true;}
        q.w=q.inside?observationWeight(q):0;
        if(k===0)q.w=Math.max(.000002,q.w);
        sum+=q.w;
        if(q.w) {photoUV(f,q.u,q.v,tuv);q.su=tuv.u;q.sv=tuv.v;}
      }
      let shadeU=0,shadeV=0,weightedDepth=0,stable=0;sky=0;
      for(let k=1;k<neighbors.length;k++){
        const q=probes[k],flow=r.flows.get(neighbors[k].id);
        if(!q.w || !flow)continue;
        uvWarp(flow,rootUV.u,rootUV.v,mapped);
        const du=clamp(mapped.u-q.su,-.31,.31),dv=clamp(mapped.v-q.sv,-.31,.31);
        const interior=smooth(0,.12,Math.min(q.u,1-q.u,q.v,1-q.v))*smooth(0,.12,Math.min(u,1-u,v,1-v));
        const slip=interior;
        shadeU+=du*slip*q.w/sum;shadeV+=dv*slip*q.w/sum;
        q.su=clamp(q.su+du*slip*probes[0].w/sum);q.sv=clamp(q.sv+dv*slip*probes[0].w/sum);
      }
      probes[0].su=clamp(rootUV.u-shadeU);probes[0].sv=clamp(rootUV.v-shadeV);
      for(let k=0;k<neighbors.length;k++){
        const f=neighbors[k],q=probes[k],weight=q.w/sum;
        if(!q.w)continue;
        const raw=rawDepth(f,q.su,q.sv),ds=f.s;
        const originDepth=(s.x-ds.x)*ds.dx+(s.y-ds.y)*ds.dy+(s.z-ds.z)*ds.dz;
        const angle=(q.d-originDepth)/d;
        const rayWeight=weight*smooth(.06,.39,Math.abs(angle));
        if(Math.abs(angle)>.055){
          weightedDepth+=rayWeight*clamp((raw-originDepth)/angle,s.near+.08,Math.min(s.far-.02,MAX_DEPTH));stable+=rayWeight;
        }
        if(f.profile.skyMask?.[indexAt(f.profile,q.su,q.sv)])sky+=weight;
      }
      if(step<2&&stable)d=weightedDepth/stable;
      if(step===2){
        let best=0;
        for(let k=0;k<neighbors.length;k++){
          const q=probes[k],a=maps[k],idx=pos*3;a[idx]=q.su;a[idx+1]=q.sv;a[idx+2]=q.w/sum;
          if(q.w>probes[best].w+.000001 || Math.abs(q.w-probes[best].w)<.000001&&neighbors[k].id<neighbors[best].id)best=k;
        }
        owned[pos]=best===0?1:0;
      }
    }
    depths[pos]=d;skies[pos]=sky>.87?1:0;
  }
  return {w,h,neighbors,maps,depths,skies,owned};
}
export function computePhotoSamples(record){
  const grid=makeRayGrid(record);
  return {grid,image:fuseAppearance(record,grid)};
}
const transitionVertex=videoVertexGL+`
  attribute vec3 startCenter;attribute vec4 startPigment;
  uniform float placement,hasPhotoMotion,hybridCore;
  uniform vec3 eye,forward,across,upAxis,observerEye;
  uniform vec2 aperture,offset,motionSize;
  uniform sampler2D motionOffsets,motionPigment;
  varying vec3 motionColor,restPoint;
  varying vec4 initialPigment;varying float movement;
  float eased(float t){return t*t*(3.-2.*t);}
  vec2 sourceRayUV(vec3 center){
    vec3 d=center-eye;
    return vec2(.5)+vec2(1.,-1.)*(vec2(dot(d,across),dot(d,upAxis))/max(.00001,dot(d,forward))-offset)/aperture;
  }
  vec3 travel(vec3 center){
    motionColor=vec3(0.);
    float phase=eased(placement);
    vec2 uv=sourceRayUV(center);
    vec3 temporal=videoMovement(center,uv)*phase;
    if(hasPhotoMotion<.5)return temporal;
    vec2 st=(clamp(uv,0.,1.)*(motionSize-1.)+.5)/motionSize;
    motionColor=texture2D(motionPigment,st).rgb*phase;
    vec3 shift=texture2D(motionOffsets,st).xyz;
    // The cells within building reach stay registered with the collision
    // lattice. The intervening band cannot move a distant block into reach.
    float range=length(center-observerEye);
    float keep=smoothstep(9.,24.,range)*min(1.,max(0.,range-9.)/max(.001,length(shift)));
    vec3 combined=shift*(keep*phase)+temporal;
    return combined*min(1.,max(0.,range-9.)/max(.001,length(combined)));
  }
`;
const vsCubes=transitionVertex+`
  attribute vec3 cellCenter;
  varying vec3 worldP,centerP,norm;
  void main(){movement=startPigment.w;initialPigment=startPigment;
    centerP=mix(startCenter,cellCenter,eased(placement));
    vec3 shift=travel(cellCenter);
    vec3 corner=position;norm=normal;
    #ifdef CAMERA_FACING_CUBE
      // The three far faces of an opaque axis-aligned block are always
      // back-facing. Reflect its three near faces into the camera octant.
      vec3 signs=step(vec3(0.),cameraPosition-centerP-shift)*2.-1.;
      if(signs.x*signs.y*signs.z<0.){corner=corner.zyx;norm=norm.zyx;}
      corner*=signs;norm*=signs;
    #endif
    restPoint=centerP+corner*hybridCore;worldP=restPoint+shift;
    gl_Position=projectionMatrix*viewMatrix*vec4(worldP,1.);
  }`;
const projectionGL=`
  uniform vec3 eye,forward,across,upAxis;
  uniform vec2 aperture,offset,lensClip;
  uniform sampler2D radiance;
  vec3 photoCoords(vec3 p){vec3 dp=p-eye;float depth=dot(dp,forward);
    return vec3(.5+(dot(dp,across)/max(depth,1e-5)-offset.x)/aperture.x,.5-(dot(dp,upAxis)/max(depth,1e-5)-offset.y)/aperture.y,depth);}
  bool outside(vec3 uvz){return min(uvz.x,uvz.y)<0. || max(uvz.x,uvz.y)>1. || uvz.z<lensClip.x || uvz.z>lensClip.y;}
`;
const transitionFragment=`
  uniform float placement,retiring,retirePhase,replaying;
  uniform vec3 stampEye,stampD,stampR,stampU;uniform vec4 stampWindow;uniform vec2 stampDepth;
  varying vec4 initialPigment;varying float movement;varying vec3 motionColor,restPoint;
  float hashPoint(vec3 p){return fract(sin(dot(floor(p*8.),vec3(12.9898,78.233,37.719)))*43758.5453);}
  bool affected(vec3 p){vec3 d=p-stampEye;float z=dot(d,stampD);vec2 uv=vec2(dot(d,stampR),dot(d,stampU))/max(z,.000001);
    return z>=stampDepth.x && z<=stampDepth.y && all(lessThanEqual(abs(uv-stampWindow.zw),stampWindow.xy*.5));}
  float visibility(vec3 p){
    if(retiring>.5){if(!affected(p))return 0.;return 1.-smoothstep(.06,.88,retirePhase);}
    if(movement<.5 || placement>=1.)return 1.;
    if(!affected(p))return 0.;
    return replaying>.5?1.:smoothstep(0.,.66,placement);
  }
  vec3 transportedColor(vec3 c){float blend=movement>.5?smoothstep(.02,.93,placement):1.;return mix(initialPigment.rgb,c,blend);}
`;
const fsCubes=videoFragmentGL+projectionGL+surfaceProjectionGL+transitionFragment+`
  uniform float materialGrain;
  varying vec3 worldP,centerP,norm;
  void main(){
    float vis=visibility(worldP);if(vis<=.0001 || vis<1. && hashPoint(worldP)>vis)discard;
    if(outside(photoCoords(worldP)))discard;vec3 uvz=photoCoords(restPoint);
    vec4 sampleColor=texture2D(radiance,uvz.xy);vec3 color=sampleColor.rgb;
    float facet=clamp(materialGrain+sampleColor.a*.40+.23*smoothstep(1.,9.,length(cameraPosition-eye)),0.,.95);
    vec3 pigment=texture2D(radiance,clamp(photoCoords(centerP).xy,0.,1.)).rgb;
    float shade=norm.y>.5?1.10:norm.y<-.5?.65:abs(norm.x)>.5?.76:.99;
    vec3 live=videoRadiance(mix(uvz.xy,photoCoords(centerP).xy,facet),mix(color,pigment,facet)+motionColor,placement);
    live=projectSurface(worldP,clamp(live,0.,1.)*mix(1.,shade,facet));
    gl_FragColor=vec4(transportedColor(live),1.);
    #include <colorspace_fragment>
  }`;
const vsSurfels=transitionVertex+`
  attribute vec3 surfacePoint,tangentU,tangentV;
  varying vec2 kernel;varying vec3 worldP;
  void main(){
    kernel=position.xy;
    movement=startPigment.w;initialPigment=startPigment;
    restPoint=mix(startCenter,surfacePoint,eased(placement))+position.x*tangentU+position.y*tangentV;
    worldP=restPoint+travel(surfacePoint);
    gl_Position=projectionMatrix*viewMatrix*vec4(worldP,1.);
  }`;
const fsSurfels=videoFragmentGL+projectionGL+surfaceProjectionGL+transitionFragment+`
  uniform float splatOpacity;
  varying vec2 kernel;varying vec3 worldP;
  void main(){
    float radius=dot(kernel,kernel);if(radius>6.25)discard;
    if(outside(photoCoords(worldP)))discard;vec3 uvz=photoCoords(restPoint);
    vec4 sampleColor=texture2D(radiance,uvz.xy);vec3 color=sampleColor.rgb;
    float vis=visibility(worldP);if(vis<.001)discard;
    vec3 live=projectSurface(worldP,clamp(videoRadiance(uvz.xy,color+motionColor,placement),0.,1.));
    gl_FragColor=vec4(transportedColor(live),vis*splatOpacity*exp(-.5*radius));
    #include <colorspace_fragment>
  }`;
function uniforms(r,tex,motion,projection){
  const s=r.s;
  return {...projection,hybridCore:{value:1},hasPhotoMotion:{value:motion?1:0},motionOffsets:{value:motion?.offsets||zeroMotionTexture},
    motionPigment:{value:motion?.pigment||zeroMotionTexture},motionSize:{value:motion?.dimensions||new THREE.Vector2(1,1)},
    observerEye:{value:new THREE.Vector3()},placement:{value:1},retiring:{value:0},retirePhase:{value:0},replaying:{value:0},...stampUniforms(s),eye:{value:new THREE.Vector3(s.x,s.y,s.z)},forward:{value:new THREE.Vector3(s.dx,s.dy,s.dz)},
    across:{value:new THREE.Vector3(s.rx,s.ry,s.rz)},upAxis:{value:new THREE.Vector3(s.ux,s.uy,s.uz)},
    aperture:{value:new THREE.Vector2(s.slopeX,s.slopeY)},offset:{value:new THREE.Vector2(s.offsetX||0,s.offsetY||0)},
    lensClip:{value:new THREE.Vector2(s.near,s.far)},radiance:{value:tex},materialGrain:{value:.16},splatOpacity:{value:.65}};
}
function stampUniforms(s){
  return {stampEye:{value:new THREE.Vector3(s.x,s.y,s.z)},stampD:{value:new THREE.Vector3(s.dx,s.dy,s.dz)},
    stampR:{value:new THREE.Vector3(s.rx,s.ry,s.rz)},stampU:{value:new THREE.Vector3(s.ux,s.uy,s.uz)},
    stampWindow:{value:new THREE.Vector4(s.slopeX,s.slopeY,s.offsetX||0,s.offsetY||0)},stampDepth:{value:new THREE.Vector2(s.near,s.far)}};
}
function changeUniforms(l,s){const settings=stampUniforms(s);for(const k of Object.keys(settings))l.uniforms[k].value.copy(settings[k].value);}
const box=new THREE.BoxGeometry(1,1,1);
const facingBox=box.clone();
const frontFaces=[];
for(let i=0;i<box.index.count;i+=3){
  const j=box.index.getX(i),n=box.attributes.normal;
  if(n.getX(j)+n.getY(j)+n.getZ(j)>0)frontFaces.push(j,box.index.getX(i+1),box.index.getX(i+2));
}
facingBox.setIndex(frontFaces);
const square=new THREE.PlaneGeometry(5,5);
function instanced(base,attributes,count){
  const geometry=new THREE.InstancedBufferGeometry();
  for(const name of ['position','normal','uv'])if(base.attributes[name])geometry.setAttribute(name,base.attributes[name].clone());
  geometry.setIndex(base.index.clone());
  for(const [name,data] of Object.entries(attributes))geometry.setAttribute(name,new THREE.InstancedBufferAttribute(new Float32Array(data),name==='startPigment'?4:3));
  geometry.instanceCount=count;return geometry;
}
function cellRecord(x,y,z,image,u,v,sky){
  const at=lookup(image,u,v),a=image.data,r=a[at],g=a[at+1],b=a[at+2];
  return {x,y,z,id:sky?0:blockId(r,g,b),tint:(r<<16)|(g<<8)|b};
}
const linear=Float32Array.from({length:256},(_,n)=>{const x=n/255;return x<.04045?x/12.92:((x+.055)/1.055)**2.4;});
function priorCell(record,atlas,x,y,z,active) {
  const exact=atlas.cells.get(key(x,y,z));if(exact)return exact;
  const q={},p={},s=active.s;
  let best=0,point=null;
  for(const old of [record,...record.neighbors]){
    if(!old.layer)continue;
    project(old.s,x+.5,y+.5,z+.5,q);if(!q.inside)continue;
    const confidenceHere=confidence(q.u,q.v);if(confidenceHere<=best)continue;
    back(old.s,q.u,q.v,gridDepth(old,q.u,q.v),p);
    if(!project(s,p.x,p.y,p.z,{}).inside)continue;
    best=confidenceHere;point=[Math.floor(p.x),Math.floor(p.y),Math.floor(p.z),old];
  }
  if(!point)return null;
  const [xx,yy,zz,old]=point;
  for(const [dx,dy,dz] of [[0,0,0],[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]){
    const c=old.layer.cells.get(key(xx+dx,yy+dy,zz+dz));
    if(c&&project(s,c.x+.5,c.y+.5,c.z+.5,{}).inside)return c;
  }
  return null;
}
function startFor(r,atlas,c,active,animate){
  if(!animate || !project(active.s,c.x+.5,c.y+.5,c.z+.5,{}).inside)
    return [c.x+.5,c.y+.5,c.z+.5,0,0,0,0];
  const from=priorCell(r,atlas,c.x,c.y,c.z,active),col=from?.tint??c.tint;
  let x,y,z;
  if(from){
    const t=atlas.transitionProgress??1,e=t*t*(3-2*t);
    x=from.start?mix(from.start[0],from.x+.5,e):from.x+.5;
    y=from.start?mix(from.start[1],from.y+.5,e):from.y+.5;
    z=from.start?mix(from.start[2],from.z+.5,e):from.z+.5;
  }else{
    // New material emerges a few cells behind its measured surface.
    const dist=3+(Math.abs(Math.imul(c.x,19)+Math.imul(c.y,79)+Math.imul(c.z,41))%4);
    x=Math.floor(c.x+.5+dist*active.s.dx)+.5;y=Math.floor(c.y+.5+dist*active.s.dy)-1+.5;
    z=Math.floor(c.z+.5+dist*active.s.dz)+.5;
  }
  return [x,y,z,linear[(col>>16)&255],linear[(col>>8)&255],linear[col&255],1];
}
async function buildLayer(r,g,atlas,active,animate,image) {
  const affected=r===active?null:active.s;
  const tex=textureOf(image),s=r.s,cells=new Map(),surfels=[],tangents=[],bitangents=[],p={},q={},dir={};
  const saved=r.layer,projection={};
  // A cell lying beyond a new view's boundary keeps its previous contents.
  if(saved&&affected)for(const [k,c] of saved.cells){
    if(!project(affected,c.x+.5,c.y+.5,c.z+.5,projection).inside)cells.set(k,c);
  }
  let slice=performance.now();
  const interactive=typeof window!=='undefined';
  const yieldFrame=async()=>{await new Promise(resolve=>setTimeout(resolve,0));slice=performance.now();};
  for(let j=0;j<g.h;j++)for(let i=0;i<g.w;i++){
    if(interactive&&i===0&&performance.now()-slice>10)await yieldFrame();
    const k=i+j*(g.w+1),u=i/g.w,v=j/g.h,d=g.depths[k],sky=g.skies[k];
    if(!g.owned[k])continue;
    back(s,u,v,d,p);
    const near=Math.max(0,d*.002);
    back(s,u,v,Math.max(s.near,d-near-.76),q);
    const shift=.52,dx=g.depths[k+1]-d,dy=g.depths[k+g.w+1]-d;
    const sw=d*s.slopeX/g.w,sh=d*s.slopeY/g.h;
    const tu=clamp(dx,-sw,sw)*shift,tv=clamp(dy,-sh,sh)*shift;
    dir.x=(p.x-s.x)/d;dir.y=(p.y-s.y)/d;dir.z=(p.z-s.z)/d;
    const px=Math.floor(p.x),py=Math.floor(p.y),pz=Math.floor(p.z);
    if(!atlas.masked.has(key(px,py,pz))){
      surfels.push(q.x,q.y,q.z);
      tangents.push(.86*(s.rx*sw+dir.x*tu),.86*(s.ry*sw+dir.y*tu),.86*(s.rz*sw+dir.z*tu));
      bitangents.push(.86*(-s.ux*sh+dir.x*tv),.86*(-s.uy*sh+dir.y*tv),.86*(-s.uz*sh+dir.z*tv));
    }
    // Unit-grid depth shells extend a little behind the observed face.
    // Their side faces consequently have thickness at disocclusions.
    for(const offset of sky?[0]:[0,.88,1.68]){
      const x=Math.floor(p.x+dir.x*offset),y=Math.floor(p.y+dir.y*offset),z=Math.floor(p.z+dir.z*offset),ck=key(x,y,z);
      if(cells.has(ck)||atlas.masked.has(ck))continue;
      const c=project(s,x+.5,y+.5,z+.5,projection);
      if(!c.inside)continue;
      const cu=c.u,cv=c.v;
      if(saved&&affected&&!project(affected,x+.5,y+.5,z+.5,projection).inside)continue;
      cells.set(ck,cellRecord(x,y,z,image,cu,cv,sky));
    }
  }
  const coords=new Float32Array(cells.size*3);let n=0;
  const starts=[],pigments=[],splatStarts=[],splatPigments=[];
  for(const c of cells.values()){
    if(interactive&&n%6144===0&&performance.now()-slice>10)await yieldFrame();
    coords[n++]=c.x+.5;coords[n++]=c.y+.5;coords[n++]=c.z+.5;
    const start=startFor(r,atlas,c,active,animate);
    if(start[6])c.start=start;else delete c.start;
    starts.push(start[0],start[1],start[2]);pigments.push(start[3],start[4],start[5],start[6]);
  }
  for(let i=0;i<surfels.length;i+=3){
    if(interactive&&i%6144===0&&performance.now()-slice>10)await yieldFrame();
    const x=surfels[i],y=surfels[i+1],z=surfels[i+2],c=cells.get(key(Math.floor(x),Math.floor(y),Math.floor(z)));
    const start=c?.start;
    if(start){splatStarts.push(x+start[0]-c.x-.5,y+start[1]-c.y-.5,z+start[2]-c.z-.5);splatPigments.push(...start.slice(3));}
    else if(animate&&project(active.s,x,y,z,projection).inside){
      const k=lookup(image,clamp(project(r.s,x,y,z,q).u),clamp(q.v)),p=image.data;
      splatStarts.push(x+3*active.s.dx,y+3*active.s.dy-1,z+3*active.s.dz);
      splatPigments.push(linear[p[k]],linear[p[k+1]],linear[p[k+2]],1);
    }else{splatStarts.push(x,y,z);splatPigments.push(0,0,0,0);}
  }
  const motion=buildPhotoMotion(r,g,back,rawDepth);
  const video=videoSamples(g),defines={STRATA_VIDEO_SLOTS:Math.min(2,video.length)};
  const uniformsUv=uniforms(r,tex,motion,atlas.projection);uniformsUv.placement.value=animate?0:1;
  Object.assign(uniformsUv,videoUniforms(video.length));
  const compact=r.budget.rayScale<1;
  const solid=new THREE.Mesh(instanced(compact?facingBox:box,{cellCenter:coords,startCenter:starts,startPigment:pigments},cells.size),
    new THREE.ShaderMaterial({defines:compact?{...defines,CAMERA_FACING_CUBE:1}:defines,uniforms:uniformsUv,vertexShader:vsCubes,fragmentShader:fsCubes,toneMapped:false,polygonOffset:true,polygonOffsetFactor:-1,polygonOffsetUnits:-1}));
  solid.userData.worldAxisCubes=true;solid.userData.stampId=r.id;solid.name='World-axis photo voxels';solid.frustumCulled=false;
  const gaussian=new THREE.Mesh(instanced(square,{surfacePoint:surfels,tangentU:tangents,tangentV:bitangents,startCenter:splatStarts,startPigment:splatPigments},surfels.length/3),
    new THREE.ShaderMaterial({defines,uniforms:uniformsUv,vertexShader:vsSurfels,fragmentShader:fsSurfels,transparent:true,depthTest:true,depthWrite:false,side:THREE.DoubleSide,forceSinglePass:true,toneMapped:false}));
  gaussian.userData.gaussianSurfels=true;gaussian.userData.stampId=r.id;gaussian.name='Depth-oriented Gaussian surfels';gaussian.frustumCulled=false;gaussian.renderOrder=24;
  const root=new THREE.Group();root.name='Live photo '+r.id;root.add(solid,gaussian);
  const bounds=new THREE.Box3();
  const pt=new THREE.Vector3();
  for(const a of [coords,starts,surfels])for(let i=0;i<a.length;i+=3)bounds.expandByPoint(pt.set(a[i],a[i+1],a[i+2]));
  if(!bounds.isEmpty())bounds.expandByScalar(3+(motion?motionLimit:0)+(video.length?videoDisplacementLimit:0));
  const corners=[];for(const depth of [s.near,Math.min(MAX_DEPTH+4,s.far)])for(const v of [0,1])for(const u of [0,1]){
    const k=back(s,u,v,depth,{});corners.push(new THREE.Vector3(k.x,k.y,k.z));
  }
  const layer={root,solid,gaussian,cells,motion,videoSamples:video,videoObservers:g.neighbors||[],ownVideoSample:video.find(sample=>sample.record===r),texture:tex,uniforms:uniformsUv,image,bounds,corners,resident:true,lod:0,overlap:r.neighbors.length>0,
    depths:g.depths,w:g.w,h:g.h,dispose(){for(const item of video)item.texture.dispose();motion?.dispose();tex.dispose();solid.material.dispose();gaussian.material.dispose();solid.geometry.dispose();gaussian.geometry.dispose();}};
  changeUniforms(layer,active.s);return layer;
}
function gridDepth(r,u,v){
  const g=(r.representative||r).layer,x=u*g.w,y=v*g.h,i=clamp(Math.round(x),0,g.w),j=clamp(Math.round(y),0,g.h);
  return g.depths[i+(g.w+1)*j];
}
function mipPixels(image,lod){
  if(lod===0)return image;
  const step=2**lod,w=Math.max(1,Math.ceil(image.width/step)),h=Math.max(1,Math.ceil(image.height/step)),data=new Uint8Array(w*h*4);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const src=lookup(image,(x+.5)/w,(y+.5)/h),dst=(x+y*w)*4;
    data[dst]=image.data[src];data[dst+1]=image.data[src+1];data[dst+2]=image.data[src+2];data[dst+3]=image.data[src+3];
  }
  return {data,width:w,height:h};
}
function releaseGpu(layer){
  if(!layer.resident)return;
  layer.texture.dispose();layer.solid.geometry.dispose();layer.gaussian.geometry.dispose();
  layer.texture.image=null;layer.resident=false;layer.root.visible=false;
}
function retainGpu(layer,lod){
  if(layer.resident&&layer.lod===lod)return;
  const image=mipPixels(layer.image,lod);
  layer.texture.dispose();layer.texture.image={data:image.data,width:image.width,height:image.height};layer.texture.needsUpdate=true;
  layer.resident=true;layer.lod=lod;
}
export class ViewVolumeAtlas {
  constructor(budget=desktopBudget,projection=projectionUniforms()){
    this.budget=budget;this.projection=projection;
    this.mesh=new THREE.Group();this.mesh.name='World-space photo stamps';this.stamps=[];this.records=this.stamps;
    this.masked=new Set();this.cells=new Map();this.sections=new Map();this.lastSection=null;this.lastKey='';
    this.query={};this.transitionProgress=1;this.animating=false;this.retiring=[];this.transitionLayers=[];this.lastPlacement=null;
    this.frustum=new THREE.Frustum();this.vp=new THREE.Matrix4();this.camera=null;this.mode='hybrid';this.splats=.65;this.pending=Promise.resolve();this.closed=false;this.lastBounds=null;
    this.sourceImages=new Map();this.sourceBytes=0;
  }
  async pixelsFor(profile){
    const key=profile.imageBlob||profile.imageURL;
    if(!key)return sourcePixels(profile,this.budget.sourceSide);
    const hit=this.sourceImages.get(key);
    if(hit){this.sourceImages.delete(key);this.sourceImages.set(key,hit);return hit;}
    const pixels=await sourcePixels(profile,this.budget.sourceSide);
    if(pixels.stride!==4)return pixels;
    this.sourceImages.set(key,pixels);this.sourceBytes+=pixels.data.byteLength;
    while(this.sourceBytes>this.budget.cacheBytes){
      const oldest=this.sourceImages.keys().next().value;
      this.sourceBytes-=this.sourceImages.get(oldest).data.byteLength;this.sourceImages.delete(oldest);
    }
    return pixels;
  }
  async add(profile,stamp,id,options={}) {
    // Repeated inputs during decoding are committed in input order.
    const append=()=>this.addOne(profile,stamp,id,options);
    const result=this.pending.then(append);this.pending=result.catch(()=>{});return result;
  }
  prepareRecord(profile,stamp,id,previous){
    if(this.closed)throw Error('The photo atlas is closed.');
    const s=cameraStamp(stamp),index=id??(previous.length?previous.at(-1).id+1:0);
    if(previous.some(r=>r.id===index))throw Error('This photo already has a stamp.');
    if(![s.x,s.y,s.z,s.slopeX,s.slopeY,s.near,s.far].every(Number.isFinite)||s.slopeX<=0||s.slopeY<=0||s.far<=s.near)
      throw Error('Invalid photo capture projection.');
    const aspect=profile.width/profile.height||profile.gridW/profile.gridH;
    const r={s,id:index,profile,budget:this.budget,source:null,cropX:Math.min(1,s.aspect/aspect),cropY:Math.min(1,aspect/s.aspect),
      neighbors:[],flows:new Map(),bounds:stampBounds(s,MAX_DEPTH+3),layer:null};
    const neighbors=previous.filter(other=>canShare(r,other));
    r.neighbors=neighbors;
    // Photos from an identical camera share one geometric sampling grid.
    // Every exposure still influences its radiance and reconstructed depth.
    const cameraKeys=['x','y','z','dx','dy','dz','rx','ry','rz','ux','uy','uz','slopeX','slopeY','offsetX','offsetY','near','far'];
    const twin=neighbors.find(p=>cameraKeys.every(k=>Math.abs((p.s[k]||0)-(s[k]||0))<1e-7));
    r.representative=twin&&(twin.representative||twin);
    // Preserve the chain a player just placed, even if an older camera has
    // a closer heading. At most two pairs need new feature matches per view.
    function similarity(p){return s.dx*p.s.dx+s.dy*p.s.dy+s.dz*p.s.dz-.005*Math.hypot(s.x-p.s.x,s.y-p.s.y,s.z-p.s.z);}
    const closest=neighbors.reduce((best,q)=>!best||similarity(q)>similarity(best)?q:best,null);
    for(const other of new Set([closest,neighbors.at(-1)])){
      if(!other || similarity(other)<=.15)continue;
      r.flows.set(other.id,correspondence(profile,other.profile,25,19));
      other.flows.set(r.id,correspondence(other.profile,profile,25,19));
    }
    for(const old of neighbors)old.neighbors.push(r);
    return r;
  }
  async fuseLayers(records,active,animate,accept){
    if(!records.length)return;
    const observers=new Set(records.flatMap(r=>[r,...r.neighbors]));
    let task;
    try{
      for(const r of observers)r.source=await this.pixelsFor(r.profile);
      task=beginFusion(observers,computePhotoSamples);
      for(const r of records){
        if(this.closed)throw Error('The photo atlas is closed.');
        if(typeof window!=='undefined')await new Promise(resolve=>setTimeout(resolve,0));
        if(r.representative&&r.layer)continue;
        const {grid,image}=r.representative
          ?{grid:{w:0,h:0,depths:new Float32Array(1)},image:{width:1,height:1,stride:4,data:new Uint8Array(4)}}
          :await task.sample(r);
        accept(r,await buildLayer(r,grid,this,active||r,animate,image));
      }
    }finally{
      task?.close();
      for(const r of observers)r.source=null;
    }
  }
  // A cold restore has no player watching the intermediate insertions. Build
  // its overlap graph first and fuse each saved viewpoint directly against its
  // final neighbors. Small batches bound decoded pixels for long, sparse walks.
  async restore(entries) {
    if(this.stamps.length)throw Error('The photo atlas already contains views.');
    const records=[];
    for(const {profile,frame,id} of entries){
      const r=this.prepareRecord(profile,frame,id,records);records.push(r);
    }
    try{
      for(let i=0;i<records.length;i+=4){
        await this.fuseLayers(records.slice(i,i+4),null,false,(r,layer)=>{r.layer=layer;});
      }
      if(this.closed)throw Error('The photo atlas is closed.');
    }catch(error){for(const r of records)r.layer?.dispose();throw error;}
    for(const r of records){
      r.motionSite=motionSite(r);this.stamps.push(r);this.indexRecord(r);this.mesh.add(r.layer.root);
      for(const [k,c] of r.layer.cells)if(c.id)this.cells.set(k,c);
    }
    if(records.length)this.lastBounds=records.at(-1).bounds;
    this.update(this.camera,this.mode,this.splats,0);
  }
  async addOne(profile,stamp,id,options){
    const animate=options.animate!==false,prepare=animate||options.prepareReplay===true;
    const r=this.prepareRecord(profile,stamp,id,this.stamps),neighbors=r.neighbors;
    const pending=[];
    try{
      await this.fuseLayers([...neighbors,r],r,prepare,(record,layer)=>pending.push([record,layer]));
      if(this.closed)throw Error('The photo atlas is closed.');
    }catch(error){
      for(const [_,layer] of pending)layer.dispose();
      for(const old of neighbors){old.neighbors=old.neighbors.filter(q=>q!==r);old.flows.delete(r.id);}
      throw error;
    }
    this.finishTransition();
    for(const [record,layer] of pending){
      if(record.layer){
        if(animate){
          const prior=record.layer;changeUniforms(prior,r.s);prior.uniforms.retiring.value=1;
          this.retiring.push(prior);
        }else{this.mesh.remove(record.layer.root);record.layer.dispose();}
      }
      record.layer=layer;this.mesh.add(layer.root);
    }
    this.stamps.push(r);this.lastBounds=r.bounds;this.indexRecord(r);
    for(const record of [r,...neighbors])record.motionSite=motionSite(record);
    // Re-index only the affected blocks, including old occupied cells that
    // moved to a different depth when another photo entered the same volume.
    const updated=new Map();
    for(const record of [r,...neighbors])for(const [k,c] of record.layer.cells){
      if(!updated.has(k)&&c.id)updated.set(k,c);
    }
    for(const [k,c] of this.cells){
      if(project(r.s,c.x+.5,c.y+.5,c.z+.5,this.query).inside && c.x>=r.bounds.minX-2 && c.x<=r.bounds.maxX+2 &&
        c.y>=r.bounds.minY-2 && c.y<=r.bounds.maxY+2 && c.z>=r.bounds.minZ-2 && c.z<=r.bounds.maxZ+2)this.cells.delete(k);
    }
    for(const [k,c] of updated)this.cells.set(k,c);
    this.transitionProgress=animate?0:1;this.animating=animate;this.transitionLayers=animate?pending.map(p=>p[1]):[];
    this.lastPlacement=prepare?pending.map(p=>p[1]):null;
    if(!animate&&prepare)for(const l of this.lastPlacement)l.uniforms.placement.value=1;
    this.update(this.camera,this.mode,this.splats,0);
    return r.id;
  }
  indexRecord(r){
    const b=r.bounds;
    for(let z=Math.floor(b.minZ/section);z<=Math.floor(b.maxZ/section);z++)
      for(let y=Math.floor(b.minY/section);y<=Math.floor(b.maxY/section);y++)for(let x=Math.floor(b.minX/section);x<=Math.floor(b.maxX/section);x++){
        const k=key(x,y,z);if(!this.sections.has(k))this.sections.set(k,[]);this.sections.get(k).push(r);
      }
    this.lastKey='';
  }
  nearby(x,y,z){
    const k=key(Math.floor(x/section),Math.floor(y/section),Math.floor(z/section));
    if(k!==this.lastKey){this.lastKey=k;this.lastSection=this.sections.get(k);}
    return this.lastSection;
  }
  contains(x,y,z){return this.stamps.some(r=>project(r.s,x,y,z,this.query).inside);}
  supportingGround(x,base,z) {
    // Carving the space in front of a depth shell can remove an entire
    // geological column. Give that space a shallow floor tied to the
    // surrounding terrain, tapering the excavation at each view boundary.
    // Measure distances in world space so a pitched or shifted camera uses
    // the same rule as a level one.
    let cut=0;
    for(const r of this.nearby(x,base-.5,z)||[]){
      if(r.representative)continue; // Its radiance is already in the shared layer.
      const s=r.s,q=project(s,x,base-.5,z,this.query);
      if(!q.inside || q.d>MAX_DEPTH+2)continue;
      const dx=q.d*s.slopeX*Math.min(q.u,1-q.u);
      const dy=q.d*s.slopeY*Math.min(q.v,1-q.v);
      const margin=Math.max(0,Math.min(dx,dy,q.d-s.near,MAX_DEPTH+2-q.d));
      cut=Math.max(cut,Math.min(4,margin*.28));
    }
    const height=base-Math.floor(cut);
    let red=0,green=0,blue=0,total=0;
    for(const r of this.nearby(x,height,z)||[]){
      if(r.representative)continue;
      // Project the actual top face. Sampling at the old height would
      // vertically displace the photograph as the player approached it.
      const q=project(r.s,x,height,z,this.query);
      if(!q.inside || q.d>MAX_DEPTH+2)continue;
      const source=photoUV(r,q.u,q.v,{});
      if(r.profile.skyMask?.[indexAt(r.profile,source.u,source.v)])continue;
      const w=observationWeight(q),im=r.layer.image,i=lookup(im,q.u,q.v);
      red+=im.data[i]*w;green+=im.data[i+1]*w;blue+=im.data[i+2]*w;total+=w;
    }
    const tint=total?(Math.round(red/total)<<16)|(Math.round(green/total)<<8)|Math.round(blue/total):undefined;
    return {height,tint};
  }
  sampleCell(x,y,z){
    const near=this.nearby(x+.5,y+.5,z+.5);if(!near)return undefined;
    const k=key(x,y,z),edit=this.masked.has(k);if(edit)return undefined;
    const solid=this.cells.get(k);if(solid)return solid;
    x+=.5;y+=.5;z+=.5;
    for(const r of near){
      const q=project(r.s,x,y,z,this.query);
      if(!q.inside||q.d<1.45||q.d>MAX_DEPTH+2)continue;
      if((x-r.s.x)**2+(y-r.s.y)**2+(z-r.s.z)**2<2.3**2)continue;
      if(q.d<gridDepth(r,q.u,q.v)+1.25)return 0;
    }
    return undefined;
  }
  contributorsAt(x,y,z,observer=null){
    const found=[];let total=0;
    for(const r of this.nearby(x,y,z)||[]){
      const q=project(r.s,x,y,z,this.query);if(!q.inside||q.d>MAX_DEPTH+2)continue;
      const weight=observationWeight(q)*(observer?viewerAffinity(observer,r.motionSite||r.s):1);if(weight<=0)continue;
      total+=weight;found.push({id:r.id,weight,u:q.u,v:q.v,depth:q.d});
    }
    for(const f of found)f.weight/=total;
    return found;
  }
  viewBlend(camera) {
    if(!this.stamps.length)return {indices:[],weights:[],dominant:-1};
    const s=camera?.isCamera?captureStamp(camera):cameraStamp(camera);
    const counts=new Map(),p={};let sum=0;
    for(const v of [.12,.35,.5,.65,.88])for(const u of [.1,.3,.5,.7,.9])for(const d of [22,52,85]){
      back(s,u,v,d,p);const observations=this.contributorsAt(p.x,p.y,p.z,s);
      for(const q of observations){counts.set(q.id,(counts.get(q.id)||0)+q.weight);sum+=q.weight;}
    }
    const ids=[...counts.keys()].sort((a,b)=>a-b),weights=ids.map(id=>counts.get(id)/sum);
    return {indices:ids,weights,dominant:ids.length?ids[weights.indexOf(Math.max(...weights))]:-1};
  }
  get canReplayPlacement(){return !!this.lastPlacement?.length;}
  replayLastPlacement(){
    if(!this.canReplayPlacement || this.closed)return false;
    this.finishTransition();
    this.transitionLayers=this.lastPlacement.slice();this.transitionProgress=0;this.animating=true;
    for(const l of this.transitionLayers){l.uniforms.placement.value=0;l.uniforms.replaying.value=1;}
    return true;
  }
  finishTransition(){
    for(const l of this.transitionLayers){
      l.uniforms.placement.value=1;l.uniforms.replaying.value=0;
      for(const cell of l.cells.values())delete cell.start;
    }
    for(const l of this.retiring){this.mesh.remove(l.root);l.dispose();}
    this.transitionLayers=[];this.retiring=[];this.transitionProgress=1;this.animating=false;
  }
  update(camera,mode='hybrid',splats=.65,dt=0) {
    this.mode=mode;this.splats=splats;if(camera)this.camera=camera;
    if(this.animating&&Number.isFinite(dt)&&dt>0){
      this.transitionProgress=Math.min(1,this.transitionProgress+dt/1.55);
      for(const l of this.transitionLayers)l.uniforms.placement.value=this.transitionProgress;
      for(const l of this.retiring)l.uniforms.retirePhase.value=this.transitionProgress;
      if(this.transitionProgress>=1)this.finishTransition();
    }
    const c=this.camera;
    if(c){c.updateWorldMatrix(true,false);this.vp.multiplyMatrices(c.projectionMatrix,c.matrixWorldInverse);this.frustum.setFromProjectionMatrix(this.vp);}
    const visible=[];let budget=0;
    const layers=this.stamps.map(r=>r.layer).concat(this.retiring);
    for(const l of layers){
      const show=!l.bounds.isEmpty() && (!c || this.frustum.intersectsBox(l.bounds) &&
        !this.frustum.planes.some(plane=>l.corners.every(p=>plane.distanceToPoint(p)<0)));
      l.root.visible=show;
      if(!show){releaseGpu(l);continue;}
      const native=l.image.width*l.image.height;
      const distance=c?l.bounds.distanceToPoint(c.position):0;
      const importance=native*Math.min(1,3000/Math.max(1,distance*distance));
      visible.push({l,native,importance});budget+=importance;
    }
    // Every visible contributor remains represented, including arbitrarily
    // old ones. Far layers share a six-megapixel radiance working set.
    for(const {l,native,importance} of visible){
      const target=Math.max(16,importance*Math.min(1,this.budget.visibleTexels/Math.max(1,budget)));
      const lod=Math.max(0,Math.ceil(Math.log2(native/target)*.5-.22));
      retainGpu(l,lod);l.root.visible=true;
      if(c&&l.motion){l.motion.update(c.position);l.uniforms.observerEye.value.copy(c.position);}
      l.solid.visible=mode!=='splat';l.gaussian.visible=mode!=='voxel'&&splats>0;
      l.uniforms.hybridCore.value=mode==='hybrid'?1-.28*splats:1;
      l.uniforms.materialGrain.value=mode==='voxel'?.84:.19;
      l.uniforms.splatOpacity.value=mode==='splat'?Math.min(.99,Math.max(.12,splats*1.5)):Math.min(.98,splats*1.48);
    }
  }
  maskCell(x,y,z){
    const k=key(x,y,z);this.masked.add(k);this.cells.delete(k);
    const layers=(this.nearby(x+.5,y+.5,z+.5)||[]).map(r=>r.layer).concat(this.retiring);
    for(const l of layers){
      for(const [node,attribute] of [[l.solid,'cellCenter'],[l.gaussian,'surfacePoint']]){
        const a=node.geometry.getAttribute(attribute),v=a.array,b=node.geometry.getAttribute('startCenter');
        for(let i=0;i<v.length;i+=3)if(Math.floor(v[i])===x&&Math.floor(v[i+1])===y&&Math.floor(v[i+2])===z){
          v[i]=1e8;b.array[i]=1e8;a.needsUpdate=b.needsUpdate=true;
        }
      }
      l.cells.delete(k);
    }
  }
  dispose(){
    this.closed=true;this.finishTransition();this.lastPlacement=null;
    for(const r of this.stamps)r.layer.dispose();
    this.mesh.clear();this.cells.clear();this.sections.clear();this.stamps.length=0;this.masked.clear();
    this.sourceImages.clear();this.sourceBytes=0;
  }
}
