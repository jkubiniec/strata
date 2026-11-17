// A small continuous displacement field is shared by the voxel and Gaussian
// instance shaders. Its endpoints are actual matched samples in the input photos.
// Reweighting these endpoints uses the current player eye and has no clock state.
import * as THREE from './vendor/three.module.js';

const mix=(a,b,t)=>a+(b-a)*t;
const clip=(v,lo=0,hi=1)=>Math.max(lo,Math.min(hi,v));
const ease=t=>t*t*(3-2*t);
const linear=Float32Array.from({length:256},(_,i)=>{
  const value=i/255;return value<=.04045?value/12.92:((value+.055)/1.055)**2.4;
});
const HALF=THREE.DataUtils.toHalfFloat;

function fieldTexture(data,w,h){
  const texture=new THREE.DataTexture(data,w,h,THREE.RGBAFormat,THREE.HalfFloatType);
  texture.minFilter=texture.magFilter=THREE.LinearFilter;
  texture.generateMipmaps=false;texture.needsUpdate=true;
  return texture;
}

export const zeroMotionTexture=fieldTexture(new Uint16Array(4),1,1);
export const motionLimit=18;

export function motionSite(record) {
  const s=record.s;
  // Photos taken without changing position are still walkable. Their viewing
  // directions and capture order distribute them down that same sight line.
  const peers=[record,...record.neighbors.filter(n=>Math.hypot(n.s.x-s.x,n.s.y-s.y,n.s.z-s.z)<2.5)];
  peers.sort((a,b)=>a.id-b.id);
  const ahead=peers.length>1?3+26*peers.indexOf(record)/(peers.length-1):0;
  return {x:s.x+s.dx*ahead,y:s.y+s.dy*ahead,z:s.z+s.dz*ahead};
}
export function viewerAffinity(eye,site){
  const dx=eye.x-site.x,dy=eye.y-site.y,dz=eye.z-site.z;
  const footprint=1+(dx*dx+dy*dy+dz*dz)/64;
  return 1/(footprint*footprint);
}

export function buildPhotoMotion(record,grid,back,rawDepth){
  if(!grid.neighbors||grid.neighbors.length<2||!grid.w||!grid.h)return null;
  const width=Math.min(51,grid.w+1),height=Math.min(Math.max(15,Math.round(width/record.s.aspect)),45,grid.h+1);
  const count=width*height,n=grid.neighbors.length;
  const neighbors=grid.neighbors;
  // One row of observations per texel: confidence, XYZ endpoint relative to the
  // fused surface, and scene-linear source RGB. We retain every contributor.
  const basis=new Float32Array(count*n*7), gate=new Float32Array(count);
  const base={},target={};
  let any=false;
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const i=y*width+x,gx=Math.round(x*grid.w/(width-1)),gy=Math.round(y*grid.h/(height-1));
    const k=gx+gy*(grid.w+1);
    back(record.s,gx/grid.w,gy/grid.h,grid.depths[k],base);
    let total=0,max=0,meanX=0,meanY=0,meanZ=0,red=0,green=0,blue=0;
    for(let j=0;j<n;j++){
      const offset=(i*n+j)*7,other=grid.neighbors[j],m=grid.maps[j],weight=m[k*3+2];
      if(weight<=0)continue;
      const u=m[k*3],v=m[k*3+1];
      back(other.s,.5+(u-.5)/other.cropX,.5+(v-.5)/other.cropY,rawDepth(other,u,v),target);
      let dx=target.x-base.x,dy=target.y-base.y,dz=target.z-base.z;
      // Only correspondence across different views should produce lateral
      // motion. Depth remains entirely determined by the photographed surfaces.
      const length=Math.hypot(dx,dy,dz),scale=length?Math.min(1,motionLimit/length):1;
      dx*=scale;dy*=scale;dz*=scale;
      const src=other.source,px=clip(Math.floor(u*src.width),0,src.width-1),py=clip(Math.floor(v*src.height),0,src.height-1);
      const p=(py*src.width+px)*src.stride,cr=linear[src.data[p]],cg=linear[src.data[p+1]],cb=linear[src.data[p+2]];
      basis[offset]=weight;basis[offset+1]=dx;basis[offset+2]=dy;basis[offset+3]=dz;
      basis[offset+4]=cr;basis[offset+5]=cg;basis[offset+6]=cb;
      total+=weight;max=Math.max(max,weight);meanX+=weight*dx;meanY+=weight*dy;meanZ+=weight*dz;
      red+=weight*cr;green+=weight*cg;blue+=weight*cb;
    }
    if(!total)continue;
    gate[i]=ease(clip((1-max/total)/.16));
    if(gate[i]<1e-6)continue;
    any=true;
    for(let j=0;j<n;j++){
      const k=(i*n+j)*7;if(!basis[k])continue;
      basis[k+1]-=meanX/total;basis[k+2]-=meanY/total;basis[k+3]-=meanZ/total;
      basis[k+4]-=red/total;basis[k+5]-=green/total;basis[k+6]-=blue/total;
    }
  }
  if(!any)return null;
  const positions=new Uint16Array(count*4),colors=new Uint16Array(count*4);
  const offsets=fieldTexture(positions,width,height),pigment=fieldTexture(colors,width,height);
  const affinity=new Float64Array(n);
  let lastX=NaN,lastY=NaN,lastZ=NaN;
  return {
    offsets,pigment,
    dimensions:new THREE.Vector2(width,height),
    update(eye){
      if(eye.x===lastX&&eye.y===lastY&&eye.z===lastZ)return;
      lastX=eye.x;lastY=eye.y;lastZ=eye.z;
      for(let j=0;j<n;j++){
        const r=neighbors[j];
        affinity[j]=viewerAffinity(eye,r.motionSite||r.s);
      }
      for(let i=0;i<count;i++){
        if(!gate[i])continue;
        let total=0,dx=0,dy=0,dz=0,red=0,green=0,blue=0;
        for(let j=0;j<n;j++){
          const k=(i*n+j)*7,w=basis[k]*affinity[j];
          total+=w;dx+=w*basis[k+1];dy+=w*basis[k+2];dz+=w*basis[k+3];
          red+=w*basis[k+4];green+=w*basis[k+5];blue+=w*basis[k+6];
        }
        const gain=gate[i]/Math.max(1e-20,total),k=i*4;
        const spatial=gain*Math.min(1,motionLimit/Math.max(1e-9,gain*Math.hypot(dx,dy,dz)));
        positions[k]=HALF(dx*spatial);positions[k+1]=HALF(dy*spatial);positions[k+2]=HALF(dz*spatial);
        colors[k]=HALF(red*gain);colors[k+1]=HALF(green*gain);colors[k+2]=HALF(blue*gain);
      }
      offsets.needsUpdate=pigment.needsUpdate=true;
    },
    // Diagnostic and CPU sampling use the same half-float texels and bilinear
    // interpolation as the shaders, including the exact rest state on return.
    offsetAt(u,v){
      const x=clip(u)*(width-1),y=clip(v)*(height-1),x0=Math.floor(x),y0=Math.floor(y);
      const x1=Math.min(width-1,x0+1),y1=Math.min(height-1,y0+1);
      const component=c=>{
        const at=(xx,yy)=>THREE.DataUtils.fromHalfFloat(positions[(yy*width+xx)*4+c]);
        return mix(mix(at(x0,y0),at(x1,y0),x-x0),mix(at(x0,y1),at(x1,y1),x-x0),y-y0);
      };
      return {x:component(0),y:component(1),z:component(2)};
    },
    dispose(){offsets.dispose();pigment.dispose();}
  };
}
