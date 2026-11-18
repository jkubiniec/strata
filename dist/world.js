import * as THREE from './vendor/three.module.js';
import { TerrainProjection } from './terrain-projection.js';

export const BLOCKS = [
  { id: 1, name: 'Grass', color: '#80a153' },
  { id: 2, name: 'Earth', color: '#947151' },
  { id: 3, name: 'Limestone', color: '#c7c6ae' },
  { id: 4, name: 'Timber', color: '#9e7951' },
  { id: 5, name: 'Steel', color: '#84969a' },
  { id: 6, name: 'Clay', color: '#c87849' },
  { id: 7, name: 'Leaves', color: '#588251' },
];

const GRASS = 1, EARTH = 2, STONE = 3, WOOD = 4, STEEL = 5, CLAY = 6, LEAF = 7;
const FLOOR = -11, TRACK_SLOPE = .36;
export const PHOTO_SLOPE = 2*Math.tan(65*Math.PI/360), PHOTO_HORIZON = .5;
const minimumPhotoSpan=2*Math.tan(12*Math.PI/360);
export function photoVerticalSlope(aspect) {
  const usual=PHOTO_SLOPE*Math.min(1,1.8/aspect);
  // A short-axis aperture supports a comfortable field of view on phones
  // or ultrawide monitors. Bound the long axis of exceptional panoramas
  // so their generated voxel and Gaussian footprints remain finite.
  const minimum=minimumPhotoSpan*Math.max(1,2.75/aspect);
  return Math.max(usual,Math.min(minimum,8/Math.max(1,aspect)));
}
export function photoDistance(depth) { return 14+74*(1-clamp(depth))**1.48; }
const clamp = (n, a = 0, b = 1) => Math.min(b, Math.max(a, n));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => { const t = clamp((x-a)/(b-a)); return t*t*(3-2*t); };
const pack = (id, color) => (id << 24) | color;
const rgb = (r,g,b) => (clamp(Math.round(r),0,255)<<16) | (clamp(Math.round(g),0,255)<<8) | clamp(Math.round(b),0,255);
const blend = (a,b,t) => rgb(lerp(a>>16,b>>16,t),lerp((a>>8)&255,(b>>8)&255,t),lerp(a&255,b&255,t));
const varied = (a,s) => rgb((a>>16)*s,((a>>8)&255)*s,(a&255)*s);
const solids = BLOCKS.map(b => pack(b.id, parseInt(b.color.slice(1), 16)));
const linear = Float32Array.from({length: 256}, (_,i) => {
  const c=i/255; return c<=0.04045 ? c/12.92 : ((c+0.055)/1.055)**2.4;
});

function hash(x,z,seed=0) {
  let n = Math.imul(x|0,374761393) + Math.imul(z|0,668265263) + Math.imul(seed|0,1274126177);
  n = Math.imul(n ^ (n >>> 13),1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}
function noise(x,z,scale,seed=0) {
  x/=scale; z/=scale;
  const ix=Math.floor(x), iz=Math.floor(z), u=smooth(0,1,x-ix), v=smooth(0,1,z-iz);
  return lerp(lerp(hash(ix,iz,seed),hash(ix+1,iz,seed),u),lerp(hash(ix,iz+1,seed),hash(ix+1,iz+1,seed),u),v);
}
function key(cx,cz) { return cx + ',' + cz; }
function makeAtlas() {
  const tile=16, wide=8*tile, data=new Uint8Array(wide*tile*4);
  for (let y=0;y<tile;y++) for (let x=0;x<wide;x++) {
    const u=x%tile, id=Math.floor(x/tile)+1;
    const grit=hash(u,y,id), clump=hash(u>>1,y>>1,id);
    let v=237 + grit*11;
    if (id===GRASS || id===LEAF) v=221+grit*22+clump*12 - (grit>.88?12:0);
    if (id===EARTH || id===CLAY) v=228+clump*13+grit*11;
    if (id===STONE) v=231+grit*12+hash(u>>2,y,id)*8;
    if (id===WOOD) v=217+noise(u*.34,y,2,id)*24+grit*12;
    if (id===STEEL) v=240+grit*9-((u===0 || y===0)?8:0);
    const i=(y*wide+x)*4;
    data[i]=data[i+1]=data[i+2]=clamp(v,0,255); data[i+3]=255;
  }
  const tex=new THREE.DataTexture(data,wide,tile,THREE.RGBAFormat);
  tex.colorSpace=THREE.SRGBColorSpace; tex.magFilter=THREE.NearestFilter;
  tex.minFilter=THREE.LinearMipmapLinearFilter; tex.generateMipmaps=true; tex.needsUpdate=true;
  return tex;
}
function pixel(profile,x,y) {
  const col=clamp(Math.floor(x*profile.gridW),0,profile.gridW-1);
  const row=clamp(Math.floor(y*profile.gridH),0,profile.gridH-1);
  return row*profile.gridW+col;
}
function sampleColor(p,i) {
  const j=i*3;
  return rgb(p.rgb[j],p.rgb[j+1],p.rgb[j+2]);
}
function surfaceId(color) {
  const r=color>>16,g=(color>>8)&255,b=color&255;
  if (g>r*1.08 && g>b*1.15) return GRASS;
  if (r>g*1.22 && g>b*1.24) return r>135?CLAY:WOOD;
  return b>r*1.05?STEEL:STONE;
}
function influence(r,u,v) {
  return smooth(-10,18,v)*(1-smooth(94,125,v))*(1-smooth(52,80,Math.abs(u)));
}
function project(r,u,v) {
  return {x:r.x+r.rightX*u+r.dx*v, z:r.z+r.rightZ*u+r.dz*v};
}
function local(r,x,z) {
  const ax=x-r.x, az=z-r.z;
  return [ax*r.rightX+az*r.rightZ,ax*r.dx+az*r.dz];
}

// Occupied cells are authored in image-local coordinates, then inverse-sampled
// into the world grid once. Diagonal attachments thus have watertight walls.
class Builder {
  constructor(region) { this.r=region; this.p=region.p; this.columns=new Map(); this.micro=new Map(); this.details=[]; }
  cell(u,y,v,id,color) {
    u=Math.round(u); v=Math.round(v); y=Math.round(y);
    const k=(u+160)*512+v+128;
    let col=this.columns.get(k);
    if (!col) { col=new Map(); this.columns.set(k,col); }
    col.set(y,pack(id,color));
  }
  roundedCell(u,y,v,color,mask) {
    this.cell(u,y,v,STEEL,color);
    const k=(u+160)*512+v+128;
    let col=this.micro.get(k);
    if(!col) { col=new Map(); this.micro.set(k,col); }
    col.set(y,mask);
  }
  box(u0,y0,v0,u1,y1,v1,id,color) {
    for (let u=Math.ceil(u0);u<=u1;u++) for (let v=Math.ceil(v0);v<=v1;v++)
      for (let y=Math.ceil(y0);y<=y1;y++) this.cell(u,y,v,id,color);
  }
  part(u,y,v,a,b,c,color) { this.details.push([u,y,v,a,b,c,color]); }
  beam(u,y,v,u2,y2,v2,thickness,color) {
    this.details.push([u,y,v,u2,y2,v2,color,thickness]);
  }
}
function cylinder(b,u,v,base,height,rad,id,col,band=null) {
  for (let x=-Math.ceil(rad);x<=rad;x++) for (let z=-Math.ceil(rad);z<=rad;z++) {
    if ((x*x+z*z)>(rad+.15)**2) continue;
    for (let j=0;j<height;j++) {
      const skin = band && band(j);
      b.cell(u+x,base+j,v+z,id,skin || varied(col,.97+.05*hash(x,z,Math.floor(j/3))));
    }
  }
}
function tree(b,u,v,y,height,green,seed) {
  const wood=0x715a43, leaf=blend(green,0x477341,.35);
  b.box(u,y,v,u,y+height-2,v,WOOD,wood);
  const radius=Math.max(2,Math.round(height*.40));
  for (let i=0;i<4;i++) {
    const a=hash(u+i,v,seed)*6.283, rr=i===0?0:radius*.63;
    const cx=u+Math.round(Math.cos(a)*rr), cz=v+Math.round(Math.sin(a)*rr);
    const cy=y+height-(i===0?0:1+Math.floor(hash(i,u,seed)*2));
    const r=i===0?radius-0.2:radius*.78;
    for(let dx=-Math.ceil(r);dx<=r;dx++) for(let dz=-Math.ceil(r);dz<=r;dz++)
      for(let dy=-Math.ceil(r*.72);dy<=r*.78;dy++) {
        const distance=(dx*dx+dz*dz)/(r*r)+(dy*dy)/(r*r*.68);
        if(distance>1.15 || (distance>.70 && hash(dx+cx,dy*91+dz+cz,seed)>.72)) continue;
        const tint=varied(leaf,.88+.13*noise(cx+dx,cz+dz,3,cy)+dy*.035);
        b.cell(cx+dx,cy+dy,cz+dz,LEAF,tint);
      }
  }
}
const iron=0x657673, silver=0xc1c8bb, lightSteel=0xaab8af, coal=0x454d45, ochre=0xc28a50;
function deck(b,u,v,y,w,d,rail=true) {
  b.part(u,y,v,w,.32,d,iron);
  if (!rail) return;
  for(const s of [-1,1]) {
    b.part(u,y+1.02,v+s*(d/2-.08),w,.12,.14,ochre);
    b.part(u,y+.63,v+s*(d/2-.08),w,.09,.09,silver);
    b.part(u+s*(w/2-.08),y+1.02,v,.14,.12,d,ochre);
    for(let x=-w/2+.2;x<=w/2;x+=2.6) b.part(u+x,y+.55,v+s*(d/2-.08),.13,1.02,.13,iron);
  }
}
function frame(b,u,v,base,w,d,height,levels) {
  const step=height/levels;
  for (const x of [-w/2,w/2]) for (const z of [-d/2,d/2])
    b.part(u+x,base+height/2,v+z,.40,height,.40,iron);
  for(let level=0;level<levels;level++) {
    const bottom=base+level*step, top=bottom+step;
    deck(b,u,v,top,w+.8,d+.8,level%2===0);
    for(const z of [-d/2,d/2]) {
      b.beam(u-w/2,bottom,v+z,u+w/2,top,v+z,.23,lightSteel);
      b.beam(u+w/2,bottom,v+z,u-w/2,top,v+z,.20,iron);
    }
    b.beam(u+w/2,bottom,v-d/2,u+w/2,top,v+d/2,.22,lightSteel);
  }
}
function ladder(b,u,v,lo,hi,w=.85) {
  b.part(u-w/2,(hi+lo)/2,v,.12,hi-lo,.14,coal);
  b.part(u+w/2,(hi+lo)/2,v,.12,hi-lo,.14,coal);
  for(let y=lo+.24;y<hi;y+=.67) b.part(u,y,v,w,.10,.14,silver);
}
function vessel(b,u,v,height,rad,base=3,col=silver) {
  cylinder(b,u,v,base,height,rad,STEEL,col,j=> j===1 || j===height-2 ? blend(col,iron,.26):null);
  cylinder(b,u,v,base+height,1,Math.max(.4,rad-.8),STEEL,blend(col,0xd6d7bd,.42));
  if (rad>2) {
    b.part(u+.5,base+height+.86,v+.5,rad*.7,.62,rad*.7,iron);
    ladder(b,u+.5,v-rad-.10,base+.1,base+height+.6,.82);
  }
}
function building(b,u,v,w,d,h,col,base=3) {
  const u0=Math.round(u-w/2), u1=u0+w-1, v0=Math.round(v-d/2), v1=v0+d-1;
  for(let x=u0;x<=u1;x++) for(let z=v0;z<=v1;z++) for(let y=base;y<base+h;y++) {
    if(x!==u0 && x!==u1 && z!==v0 && z!==v1 && y<base+h-1) continue;
    const window=(y-base)%4===2 && (x-u0)%4<2 && z===v0 && x!==u0 && x!==u1;
    const tint=window?0x657c78:varied(col,.96+.055*hash(x>>1,z>>1,y>>2));
    b.cell(x,y,z,window?STEEL:STONE,tint);
  }
  b.part((u0+u1+1)/2,base+h+.12,(v0+v1+1)/2,w+.48,.24,d+.48,iron);
}
function prepareProjection(r) {
  const p=r.p, aspect=p.width/p.height || p.gridW/p.gridH;
  r.aspect=aspect;
  r.slope=photoVerticalSlope(aspect);
  r.subjects=(p.detections||[]).filter(d=>d.score>.24 && d.w*d.h>.009).map(d=>{
    const depths=[];
    for(let j=1;j<8;j++) for(let i=1;i<8;i++)
      depths.push(p.depth[pixel(p,d.x+d.w*i/8,d.y+d.h*j/8)]||0);
    depths.sort((a,b)=>a-b);
    const dep=depths[32], dist=photoDistance(dep);
    return {...d,dep,dist};
  });
  r.cutPhoto=!r.starter;
  // The floor nearest the photographer is the most reliable evidence for
  // continuing behind the camera. Exclude detected subjects from that palette.
  r.groundColors=[];
  let variation=0,samples=0;
  for(let stripe=0;stripe<8;stripe++) {
    const channels=[[],[],[]];
    for(let j=0;j<9;j++) for(let i=0;i<7;i++) {
      const u=(stripe+(i+.5)/7)/8, v=.68+.30*(j+.5)/9;
      const k=pixel(p,u,v);
      if(p.skyMask[k] || r.subjects.some(d=>u>d.x && u<d.x+d.w && v>d.y && v<d.y+d.h)) continue;
      const color=sampleColor(p,k);
      channels[0].push(color>>16);channels[1].push((color>>8)&255);channels[2].push(color&255);
      variation+=Math.abs(p.depth[k]-p.depth[pixel(p,u+.045,v-.08)]); samples++;
    }
    if(channels[0].length) {
      channels.forEach(c=>c.sort((a,b)=>a-b));
      const m=channels[0].length>>1; r.groundColors.push(rgb(channels[0][m],channels[1][m],channels[2][m]));
    }
  }
  if(!r.groundColors.length) r.groundColors.push(sampleColor(p,pixel(p,.15,.94)),sampleColor(p,pixel(p,.85,.94)));
  r.roughness=clamp(variation/Math.max(1,samples)*3.7+.18);
  const mid=project(r,0,39); r.ex=mid.x; r.ez=mid.z;
  r.floorMap=new Float32Array(64*96).fill(-4.6);
  for(let j=0;j<p.gridH;j+=2) {
    const v=(j+.5)/p.gridH;
    if(v<PHOTO_HORIZON) continue;
    for(let i=0;i<p.gridW;i+=2) {
      const k=j*p.gridW+i; if(p.skyMask[k]) continue;
      const dist=photoDistance(p.depth[k]), z=Math.round(dist), bx=Math.floor(i*64/p.gridW);
      const h=clamp((PHOTO_HORIZON-v)*r.slope*dist-.8,-28,0);
      for(let x=Math.max(0,bx-1);x<=Math.min(63,bx+1);x++)
        for(let depth=Math.max(0,z-3);depth<=Math.min(95,z+4);depth++) {
          const index=x*96+depth; r.floorMap[index]=Math.min(r.floorMap[index],h);
        }
    }
  }
}
function biomeTree(regions,axis=0) {
  if(!regions.length) return null;
  const field=axis?'ez':'ex';
  regions.sort((a,b)=>a[field]-b[field]);
  const m=regions.length>>1;
  return {r:regions[m],axis,left:biomeTree(regions.slice(0,m),1-axis),right:biomeTree(regions.slice(m+1),1-axis)};
}
function nearestBiomes(tree,x,z) {
  let first=null,second=null,d1=Infinity,d2=Infinity;
  function visit(n) {
    if(!n) return;
    const dx=x-n.r.ex,dz=z-n.r.ez, ds=dx*dx+dz*dz;
    if(ds<d1) { second=first;d2=d1;first=n.r;d1=ds; } else if(ds<d2) { second=n.r;d2=ds; }
    const cut=n.axis?dz:dx, left=cut<0;
    visit(left?n.left:n.right);
    if(cut*cut<d2) visit(left?n.right:n.left);
  }
  visit(tree); return [first,second];
}
function exterior(r,coarse,fine) {
  const p=r.p, palette=r.groundColors;
  const index=clamp(.69*coarse+.31*fine)*(palette.length-1), lower=Math.floor(index);
  let color=blend(palette[lower],palette[Math.min(lower+1,palette.length-1)],index-lower);
  // Brightness changes at geological scales and at the scale of one turf block.
  color=varied(color,.94+fine*.12);
  let id=surfaceId(color);
  const organic=p.kind==='landscape'||p.kind==='woodland';
  if(p.kind==='woodland' && ((color>>8)&255)>(color&255)*1.13) id=GRASS;
  if(p.kind==='industrial' && r.starter) { id=GRASS;color=blend(color,0x84965c,.42); }
  if(p.kind==='interior' || p.kind==='urban') id=id===WOOD?WOOD:STONE;
  const relief=organic?5+r.roughness*13:2+r.roughness*4;
  const h=Math.max(FLOOR+2,r.anchorH-4+coarse*relief+fine*(organic?2.3:.9));
  return [h,id,color];
}
function subjectAt(r,u,v,depth) {
  return r.subjects.find(d=>u>=d.x && u<=d.x+d.w && v>=d.y && v<=d.y+d.h && depth>=d.dep-.16);
}
function observedVolume(r,u,v,radius=0) {
  if(r.starter || v<1)return false;
  const nx=.5+u/(r.aspect*r.slope*v);
  if(nx<-.05 || nx>1.05)return false;
  // Complete the scene beyond the source relief. Keep its original field
  // of view free from guessed foreground trees and buildings.
  const k=pixel(r.p,clamp(nx),.58);
  return v-radius<photoDistance(r.p.depth[k])+4;
}
function inSubjectCorridor(r,u,v) {
  if(v<5) return false;
  const nx=.5+u/(r.aspect*r.slope*v);
  return r.subjects.some(d=>nx>d.x-.08 && nx<d.x+d.w+.08 && v<d.dist+9);
}
function groundAt(world,b,u,v) {
  const q=project(b.r,u+.5,v+.5);
  return world.getGround(q.x,q.z);
}
function woodland(world,b,starter) {
  const p=b.p, seed=p.seed|0;
  for(let i=0;i<(starter?112:190);i++) {
    const u=Math.floor(lerp(-76,76,hash(i,1,seed)));
    const v=Math.floor(lerp(-10,114,hash(i,2,seed)));
    if(starter && Math.abs(u)<52 && v<86) continue;
    if(!starter && (v<9 || (Math.abs(u)<3 && v<23) || inSubjectCorridor(b.r,u,v) || observedVolume(b.r,u,v,5))) continue;
    const s=pixel(p,.5+u/147,.86-v*.0055), col=sampleColor(p,s);
    const g=(col>>8)&255, red=col>>16, blue=col&255;
    const chance=starter?.85:p.kind==='woodland'?clamp(.4+(g-blue)/95,.33,1):clamp((g-red*.85)/95,.025,.5);
    if(hash(i,3,seed)>chance || p.skyMask[s] && !starter) continue;
    const floor=groundAt(world,b,u,v);
    const height=Math.round(lerp(3.5,9.5,hash(i,4,seed))+(p.depth[s]||.25)*2);
    tree(b,u,v,floor,height,starter?0x68834e:blend(0x5e814c,col,.55),seed+i);
  }
}
function plantDetail(world,b) {
  const seed=b.p.seed|0, starter=b.r.starter;
  for(let i=0;i<1650;i++) {
    const u=Math.floor(lerp(-72,72,hash(i,23,seed))), v=Math.floor(lerp(-24,95,hash(i,34,seed)));
    if(starter && v-u*TRACK_SLOPE>16 && v<83 && Math.abs(u)<60) continue;
    if(starter && Math.abs(u-(-4+.34*v))<1.25) continue;
    if(!starter && (b.p.kind==='interior' || b.p.kind==='urban' || b.p.kind==='industrial')) continue;
    const y=groundAt(world,b,u,v), patch=noise(u,v,7,seed);
    if(patch<.35) continue;
    const l=.23+.30*hash(i,17,seed);
    const tint=varied(starter?0x7b8748:0x6b9150,.88+patch*.34);
    b.part(u+.29,y+l/2,v+.55,.15,l,.14,tint);
    b.part(u+.53,y+l*.34,v+.42,.12,l*.68,.13,varied(tint,1.1));
    if(hash(i,39,seed)>.960) b.part(u+.31,y+l+.035,v+.54,.24,.11,.2,0xd9cb91);
  }
}
function skyline(p,x) {
  let y=0;
  for(;y<p.gridH-1;y++) if(!p.skyMask[pixel(p,x,y/p.gridH)]) break;
  return y/p.gridH;
}
function industrialExtension(world,b) {
  const p=b.p;
  for(let i=0;i<23;i++) {
    const nx=(i+.45)/23, src=pixel(p,nx,lerp(skylineCached(b.r,nx),.84,.53));
    const depth=p.depth[src], tint=blend(sampleColor(p,src),0xa0a79a,.19);
    const dist=Math.round(clamp(photoDistance(depth)+7+9*hash(i,12,p.seed),33,91));
    const u=Math.round((nx-.5)*dist*b.r.slope*b.r.aspect);
    if(inSubjectCorridor(b.r,u,dist) || observedVolume(b.r,u,dist,4)) continue;
    const rad=1.3+hash(i,8,p.seed)*2.6, base=groundAt(world,b,u,dist);
    const h=Math.max(3,Math.round((.86-skylineCached(b.r,nx))*dist*.34+(depth-.5)*8));
    vessel(b,u,dist,h,rad,base,tint);
    if(i%3===0) frame(b,u+.5,dist+.5,base,rad*2+2,rad*2+2,h,3);
  }
}
function city(world,b) {
  const p=b.p, seed=p.seed|0;
  for(let row=0;row<3;row++) {
    for(let n=0;n<9;n++) {
      const u=(n-4)*13+Math.round(hash(n,row,seed)*4-2), v=31+row*23+Math.round(hash(row,n,seed)*5);
      const x=clamp(.5+u/123), sy=skyline(p,x), i=pixel(p,x,lerp(sy,.89,.42));
      const height=Math.round(5+clamp(1-sy, .12,.95)*16+(p.depth[i]||0)*9+hash(n,row+3,seed)*6);
      const w=6+Math.floor(hash(n,15+row,seed)*6), d=6+Math.floor(hash(n,30+row,seed)*6);
      if((row===0 && Math.abs(u)<5) || inSubjectCorridor(b.r,u,v) || observedVolume(b.r,u,v,6)) continue;
      const base=groundAt(world,b,u,v), col=blend(sampleColor(p,i),0xb6af9d,.22);
      building(b,u,v,w,d,height,col,base);
      if(hash(n,row+17,seed)>.50) b.box(u-1,base+height,v-1,u+1,base+height+1,v+1,STEEL,varied(col,.76));
    }
  }
}
// Reproject a color/depth image to occupied voxels, filling the invisible side
// with a tapered thickness inferred from object extent and local depth.
function photoVolume(world,b) {
  const p=b.p, seed=p.seed|0, inside=p.kind==='interior';
  const gw=Math.round(54+clamp(p.detail||0)*58);
  const gh=Math.min(96,Math.max(20,Math.round(gw*clamp(p.height/p.width,.36,1.55))));
  const center=pixel(p,.5,.5);
  const entry=world.getGround(b.r.x,b.r.z)+1.66;
  for(let j=0;j<gh;j++) for(let i=0;i<gw;i++) {
    const u=(i+.5)/gw,v=(j+.5)/gh, pi=pixel(p,u,v);
    if(p.skyMask[pi]) continue;
    const dep=p.depth[pi]||0, col=sampleColor(p,pi), dist=photoDistance(dep);
    const subject=subjectAt(b.r,u,v,dep);
    // Every scene receives image-derived geometry, including objects outside
    // the detector's vocabulary. Leave the bottom continuation traversable.
    if(!subject && v>.91) continue;
    const xu=Math.round((u-.5)*dist*b.r.slope*b.r.aspect);
    if(Math.abs(xu)>74 || (inside && !subject && Math.abs(xu)<2 && v>.46)) continue;
    const base=groundAt(world,b,xu,dist);
    const y=Math.round(entry+(PHOTO_HORIZON-v)*dist*b.r.slope);
    if(y<base-.6) continue;
    const id=surfaceId(col);
    const thick=subject?clamp(Math.round(Math.min(subject.w*b.r.aspect,subject.h)*dist*b.r.slope*.35),1,9):2+Math.round(dep*3);
    const width=Math.floor(dist*b.r.slope*b.r.aspect/gw*.52+.2);
    const height=Math.floor(dist*b.r.slope/gh*.52+.18);
    const softened=blend(col,0xb3aea0,.035), startZ=Math.round(dist);
    for(let z=0;z<=thick;z++) {
      const tint=z===0?softened:varied(blend(softened,sampleColor(p,center),.10*z/thick),.96-.08*z/thick);
      const span=z===thick && width>1?width-1:width;
      const bottom=Math.max(base,y-height);
      b.box(xu-span,bottom,startZ+z,xu+span,y+height,startZ+z,id,tint);
    }
    if(subject && v>subject.y+subject.h*.86 && base<y-1 && hash(i,j,seed)<.7)
      b.box(xu,base,startZ+1,xu,y,startZ+1,id,varied(softened,.77));
  }
  for(const detection of (p.detections || []).slice(0,18)) {
    if(detection.score<.35) continue;
    const nx=detection.x+detection.w*.5, ny=detection.y+detection.h*.5;
    const i=pixel(p,nx,ny), dist=Math.round(photoDistance(p.depth[i]));
    const u=Math.round((nx-.5)*dist*b.r.slope*b.r.aspect), base=groundAt(world,b,u,dist);
    const color=sampleColor(p,i), label=String(detection.label||'').toLowerCase();
    if(/plant|tree/.test(label)) tree(b,u,dist,base,clamp(Math.round(detection.h*26),3,12),color,seed+i);
    if(/car|truck|bus|train/.test(label) && detection.w*detection.h<.040) {
      const w=clamp(Math.round(detection.w*38),3,14);
      b.box(u-w/2,base+1,dist,u+w/2,base+2,dist+3,STEEL,color);
      b.box(u-w/3,base+3,dist+1,u+w/3,base+3,dist+2,STEEL,varied(color,.81));
    }
  }
}
function terrain(r,u,v) {
  const p=r.p, f=noise(u,v,22,p.seed), fine=noise(u,v,6,p.seed+11);
  const nx=clamp(.5+u/(37+Math.max(v,0)*1.25));
  const py=clamp(.98-clamp(v/110)*.57), i=pixel(p,nx,py);
  const photo=sampleColor(p,i), depth=p.depth[i]||0;
  let h, col, id;
  if(p.kind==='industrial') {
    // A level access yard under the observed machinery, rising at its edges.
    const rim=smooth(42,83,Math.abs(u))+smooth(63,115,v);
    h=4+f*1.6+rim*(2+depth*5);
    col=blend(photo,0x888a80,.26);id=surfaceId(col);
  } else {
    const detailed=p.kind==='landscape'||p.kind==='woodland';
    const center=1-smooth(5,18,Math.abs(u));
    const ridge=1-skylineCached(r,nx);
    h=3+f*(detailed?8:3.4)+fine*1.8+(detailed?ridge*(1-depth)*17:depth*2.8);
    h-=detailed?center*3:0;
    col=blend(photo,detailed?0x81965c:0xb1aa91,detailed?.31:.37);
    id=surfaceId(col);
    if(p.kind==='woodland') { id=GRASS; col=blend(col,0x6a874f,.34); }
    if(p.kind==='urban' || p.kind==='interior') id=STONE;
  }
  h+=r.lift;
  if(r.cutPhoto) {
    const nx=.5+u/(r.aspect*r.slope*Math.max(1,v));
    const w=smooth(3,16,v)*(1-smooth(81,94,v))*smooth(-.1,.07,nx)*(1-smooth(.93,1.1,nx));
    if(w>0) {
      const b=clamp(Math.floor(nx*64),0,63)*96, z=clamp(Math.round(v),1,94);
      const floor=(r.floorMap[b+z-1]+2*r.floorMap[b+z]+r.floorMap[b+z+1])/4;
      h=lerp(h,Math.min(h,r.anchorH+1.66+floor),w);
    }
  }
  return [h,id,varied(col,.95+fine*.075+(hash(Math.floor(u),Math.floor(v),p.seed)-.5)*.035)];
}
function skylineCached(r,nx) { return r.skyline[clamp(Math.floor(nx*64),0,63)]; }

const faces=[
  {n:[1,0,0],c:[[1,0,1],[1,0,0],[1,1,0],[1,1,1]],s:.91},
  {n:[-1,0,0],c:[[0,0,0],[0,0,1],[0,1,1],[0,1,0]],s:.99},
  {n:[0,1,0],c:[[0,1,1],[1,1,1],[1,1,0],[0,1,0]],s:1},
  {n:[0,-1,0],c:[[0,0,0],[1,0,0],[1,0,1],[0,0,1]],s:.70},
  {n:[0,0,1],c:[[0,0,1],[1,0,1],[1,1,1],[0,1,1]],s:.98},
  {n:[0,0,-1],c:[[1,0,0],[0,0,0],[0,1,0],[1,1,0]],s:.90}
];
for(const f of faces) {
  const axes=[0,1,2].filter(k=>!f.n[k]);
  f.ao=f.c.map(c=>{
    const a=[...f.n], b=[...f.n], ab=[...f.n];
    a[axes[0]]+=c[axes[0]]?1:-1; b[axes[1]]+=c[axes[1]]?1:-1;
    ab[axes[0]]=a[axes[0]]; ab[axes[1]]=b[axes[1]];
    return [a,b,ab];
  });
}
const stub={ h:0, top:0, forms:null, edits:null };
// Signed lateral distance to the finite footpath segment. Extend the end
// caps a little so the first and last steps remain clear during a turn.
function walkLane(route,x,z) {
  const ox=x-route.x,oz=z-route.z;
  const along=ox*route.dx+oz*route.dz;
  if(along < -2.5 || along>route.length+2.5)return null;
  const lateral=Math.abs(oz*route.dx-ox*route.dz);
  if(lateral>=4.25)return null;
  return {lateral,grade:lerp(route.y0,route.y1,clamp(along/route.length))};
}
// Test the actual oriented box against the graded corridor's clipping
// planes. A tall pipe can enter headroom even when its pivot is underground.
function beamCrossesPassage(detail,route) {
  const e=detail.m.elements;
  const x=detail.x-route.x,z=detail.z-route.z;
  const along=x*route.dx+z*route.dz, side=z*route.dx-x*route.dz;
  const radius=(a,b,c)=>.5*(Math.abs(a*e[0]+b*e[1]+c*e[2])
    +Math.abs(a*e[4]+b*e[5]+c*e[6])+Math.abs(a*e[8]+b*e[9]+c*e[10]));
  const forwardRadius=radius(route.dx,0,route.dz);
  if(along+forwardRadius < -2.5 || along-forwardRadius>route.length+2.5)return false;
  if(Math.abs(side)-radius(-route.dz,0,route.dx)>2.15)return false;
  const slope=(route.y1-route.y0)/route.length;
  const above=detail.y-(route.y0+clamp(along,0,route.length)*slope);
  const verticalRadius=radius(-slope*route.dx,1,-slope*route.dz);
  return above+verticalRadius>=-.08 && above-verticalRadius<5;
}
function readCol(col,y,withEdits=true) {
  const edit=withEdits ? col.edits?.get(y) : undefined;
  if(edit!==undefined) return edit;
  if(col.lane && y>=col.h && y<col.h+5)return 0;
  const form=col.forms?.get(y);
  if(form!==undefined) return form;
  if(y>=col.h || y<FLOOR) return 0;
  if(y===col.h-1) return col.top;
  return y>=col.h-4 ? col.sub : col.deep;
}
function mapColumn(index,cx,cz,i,create=false) {
  const k=key(cx,cz);
  let cols=index.get(k);
  if(!cols && create) { cols=new Array(256); index.set(k,cols); }
  if(!cols) return null;
  if(!cols[i] && create) cols[i]=new Map();
  return cols[i]||null;
}

export class VoxelWorld {
  constructor(scene,budget={chunkRadius:7}) {
    this.budget=budget;
    this.scene=scene;
    this.group=new THREE.Group(); this.group.name='Voxel world'; scene.add(this.group);
    this.regions=[]; this.regionIndex=new Map(); this.terrain=new Map(); this.passages=new Map();
    this.forms=new Map(); this.micro=new Map(); this.edits=new Map(); this.details=new Map(); this.meshes=new Map();
    this.viewChunks=new Map(); this.viewAtlas=null;
    this.atlas=makeAtlas();
    this.surfaceMaterial=new THREE.MeshLambertMaterial({map:this.atlas,vertexColors:true});
    this.terrainProjection=new TerrainProjection(this.surfaceMaterial);
    this.trimMaterial=new THREE.MeshLambertMaterial({color:0xffffff});
    this.unitBox=new THREE.BoxGeometry(1,1,1);
    this.dirty=new Set(); this.queue=[]; this.lastChunk=''; this.lastSampleKey=''; this.lastSample=null;
    this.focus={x:0,z:0}; this.forward={x:0,z:-1};
  }
  addPassage(fromAnchor,toAnchor) {
    const sx=toAnchor.x-fromAnchor.x,sz=toAnchor.z-fromAnchor.z,length=Math.hypot(sx,sz);
    if(length<1)return;
    const route={x:fromAnchor.x,z:fromAnchor.z,dx:sx/length,dz:sz/length,length,
      y0:this.getGround(fromAnchor.x,fromAnchor.z),y1:this.getGround(toAnchor.x,toAnchor.z)};
    const touched=new Set();
    // March through affected chunks rather than scanning a quadratic
    // bounding box when saved regions are very far apart.
    for(let t=0;t<length+8;t+=8) {
      const d=Math.min(length,t), x=route.x+route.dx*d,z=route.z+route.dz*d;
      for(let cx=Math.floor((x-10)/16);cx<=Math.floor((x+10)/16);cx++)
        for(let cz=Math.floor((z-10)/16);cz<=Math.floor((z+10)/16);cz++) touched.add(key(cx,cz));
    }
    for(const k of touched) {
      const routes=this.passages.get(k) || [];
      routes.push(route);this.passages.set(k,routes);
      this.terrain.delete(k);this.dirty.add(k);
    }
    for(const k of this.meshes.keys()) {
      if(!touched.has(k) && this.details.get(k)?.some(d=>beamCrossesPassage(d,route))) this.dirty.add(k);
    }
    this.lastSampleKey='';this.lastSample=null;this.lastChunk='';
    return route;
  }
  addRegion(profile,anchor) {
    const first=this.regions.length===0;
    const d=Math.hypot(anchor.dx,anchor.dz)||1;
    const r={x:anchor.x,z:anchor.z,dx:anchor.dx/d,dz:anchor.dz/d,
      rightX:-anchor.dz/d,rightZ:anchor.dx/d,p:profile,starter:first,lift:0};
    r.anchorH=first?12:this.getGround(r.x,r.z);
    if(!first) r.lift=Math.round(r.anchorH)-6;
    prepareProjection(r);
    r.skyline=Float32Array.from({length:64},(_,i)=>skyline(profile,(i+.5)/64));
    this.regions.push(r);
    this.biomes=biomeTree(this.regions.slice());
    // Re-evaluate cached outer biomes wherever a new photo can be one of
    // the two nearest. Explicit player edits live in a separate index.
    for(const k of this.terrain.keys()) {
      const [cx,cz]=k.split(',').map(Number);
      const near=nearestBiomes(this.biomes,cx*16+8,cz*16+8);
      if(near.includes(r)) { this.terrain.delete(k); if(this.meshes.has(k)) this.dirty.add(k); }
    }
    const corners=[[-85,-42],[-85,143],[85,-42],[85,143]].map(([u,v])=>project(r,u,v));
    const xmin=Math.floor(Math.min(...corners.map(c=>c.x))/16), xmax=Math.floor(Math.max(...corners.map(c=>c.x))/16);
    const zmin=Math.floor(Math.min(...corners.map(c=>c.z))/16), zmax=Math.floor(Math.max(...corners.map(c=>c.z))/16);
    for(let cz=zmin;cz<=zmax;cz++) for(let cx=xmin;cx<=xmax;cx++) {
      const k=key(cx,cz), list=this.regionIndex.get(k)||[];
      list.push(r); this.regionIndex.set(k,list);
      this.terrain.delete(k); this.dirty.add(k);
      if(!first) this.clearFootprint(r,cx,cz);
    }
    this.lastSampleKey=''; this.lastSample=null;
    const b=new Builder(r);
    if(profile.kind==='industrial') industrialExtension(this,b);
    if(profile.kind==='urban') city(this,b);
    if(!first) photoVolume(this,b);
    if(profile.kind==='woodland' || profile.kind==='landscape' || first) woodland(this,b,first);
    plantDetail(this,b);
    // Structures rotate with the photograph. Iterate candidate world centers
    // around each occupied source column, then resolve to its exact source.
    for(const [k,column] of b.columns) {
      const u=Math.floor(k/512)-160, v=k%512-128, q=project(r,u+.5,v+.5);
      for(let z=Math.floor(q.z-.72);z<=Math.floor(q.z+.72);z++) for(let x=Math.floor(q.x-.72);x<=Math.floor(q.x+.72);x++) {
        const [lu,lv]=local(r,x+.5,z+.5);
        if(Math.floor(lu)!==u || Math.floor(lv)!==v) continue;
        if(!first && influence(r,lu,lv)<noise(x,z,6,profile.seed)*.55+.07) continue;
        const dest=mapColumn(this.forms,x>>4,z>>4,(z&15)*16+(x&15),true);
        for(const [y,raw] of column) dest.set(y,raw);
        const fine=b.micro.get(k);
        if(fine) {
          const microCol=mapColumn(this.micro,x>>4,z>>4,(z&15)*16+(x&15),true);
          for(const [y,sourceMask] of fine) {
            let mask=sourceMask&256;
            for(let zs=0;zs<2;zs++) for(let xs=0;xs<2;xs++) {
              const [su,sv]=local(r,x+.25+xs*.5,z+.25+zs*.5);
              const sb=(Math.floor(su*2)&1)+4*(Math.floor(sv*2)&1);
              for(let ys=0;ys<2;ys++) if(sourceMask&(1<<(sb+ys*2))) mask|=1<<(xs+ys*2+zs*4);
            }
            microCol.set(y,mask);
          }
        }
      }
    }
    for(const detail of b.details) this.recordDetail(r,detail);
    // Columns cached while choosing vegetation bases may have predated forms.
    for(let cz=zmin;cz<=zmax;cz++) for(let cx=xmin;cx<=xmax;cx++) this.terrain.delete(key(cx,cz));
    this.lastSampleKey=''; this.lastSample=null; this.lastChunk='';
    if(first) {
      this.forward={x:r.dx,z:r.dz}; this.focus={x:r.x,z:r.z};
      // The initial shadow map and first playable frame include the full yard.
      for(let cz=zmin;cz<=zmax;cz++) for(let cx=xmin;cx<=xmax;cx++) {
        const [u,v]=local(r,cx*16+8,cz*16+8);
        if(v>=-10 && v<99 && Math.abs(u)<Math.min(82,(Math.max(0,v)+16)*1.52))
          this.makeChunk(cx,cz);
      }
    }
    return r;
  }
  clearFootprint(r,cx,cz) {
    const k=key(cx,cz), cols=this.forms.get(k), micro=this.micro.get(k);
    const erase=(x,z)=>{
      const [u,v]=local(r,x,z);
      if(r.cutPhoto && v>-2 && v<15 && Math.abs(u)<4+v*.66) return true;
      return influence(r,u,v)>noise(x,z,9,r.p.seed)*.56+.18;
    };
    if(cols) {
      for(let i=0;i<256;i++) if(cols[i] && erase(cx*16+(i&15)+.5,cz*16+(i>>4)+.5)) {
        cols[i]=undefined; if(micro) micro[i]=undefined;
      }
      if(!cols.some(Boolean)) this.forms.delete(k);
    }
    const details=this.details.get(k);
    if(details) this.details.set(k,details.filter(d=>!erase(d.x,d.z)));
  }
  recordDetail(r,d) {
    const first=project(r,d[0],d[2]), m=new THREE.Matrix4();
    const lift=0;
    const q=new THREE.Quaternion(), s=new THREE.Vector3(), pos=new THREE.Vector3();
    if(d.length===8) {
      const last=project(r,d[3],d[5]);
      const delta=new THREE.Vector3(last.x-first.x,d[4]-d[1],last.z-first.z);
      const length=delta.length(); if(length<.001) return;
      q.setFromUnitVectors(new THREE.Vector3(0,1,0),delta.multiplyScalar(1/length));
      s.set(d[7],length,d[7]);
      pos.set((first.x+last.x)/2,(d[1]+d[4])/2+lift,(first.z+last.z)/2);
    } else {
      q.setFromAxisAngle(new THREE.Vector3(0,1,0),Math.atan2(-r.rightZ,r.rightX));
      s.set(d[3],d[4],d[5]); pos.set(first.x,d[1]+lift,first.z);
    }
    if(!r.starter) {
      const [u,v]=local(r,pos.x,pos.z);
      if(influence(r,u,v)<noise(pos.x,pos.z,6,r.p.seed)*.55+.07) return;
    }
    m.compose(pos,q,s);
    const k=key(Math.floor(pos.x/16),Math.floor(pos.z/16));
    const list=this.details.get(k)||[];
    list.push({m,c:d[6],x:pos.x,y:pos.y,z:pos.z}); this.details.set(k,list);
  }
  chunkData(cx,cz) {
    const k=key(cx,cz);
    if(this.lastSampleKey===k && this.lastSample) return this.lastSample;
    let cols=this.terrain.get(k);
    if(!cols) {
      cols=new Array(256);
      const regions=this.regionIndex.get(k)||[], forms=this.forms.get(k), micro=this.micro.get(k), edits=this.edits.get(k);
      const [near,other]=nearestBiomes(this.biomes,cx*16+8,cz*16+8);
      for(let i=0;i<256;i++) {
        const x=cx*16+(i&15), z=cz*16+(i>>4);
        const coarse=noise(x,z,31,101), fine=noise(x,z,8,66);
        let h=2+coarse*8+fine*2, id=GRASS, tint=blend(0x77884e,0x98aa62,coarse*.7+fine*.3);
        if(near) {
          [h,id,tint]=exterior(near,coarse,fine);
          if(other) {
            const difference=Math.hypot(x-other.ex,z-other.ez)-Math.hypot(x-near.ex,z-near.ez);
            const w=1-smooth(-44,44,difference);
            if(w>0) { const [otherH,otherId,otherTint]=exterior(other,coarse,fine);
              h=lerp(h,otherH,w); tint=blend(tint,otherTint,w); if(w>.5) id=otherId;
            }
          }
        }
        for(const r of regions) {
          const [u,v]=local(r,x+.5,z+.5);
          const w=r.starter?(1-smooth(66,83,Math.abs(u)))*smooth(-40,-23,v)*(1-smooth(110,139,v)):influence(r,u,v);
          if(w<=0) continue;
          const [regionH,regionId,regionTint]=terrain(r,u,v);
          h=lerp(h,regionH,w); tint=blend(tint,regionTint,w);
          if(w>.45) id=regionId;
          if(!r.starter && r.cutPhoto) {
            const entry=smooth(-3,0,v)*(1-smooth(18,30,v))*(1-smooth(5,16,Math.abs(u)-v*.72));
            h=lerp(h,Math.min(h,r.anchorH+.35-.56*Math.min(v,22)),entry);
          }
        }
        let lane=false;
        for(const route of this.passages.get(k)||[]) {
          const pass=walkLane(route,x+.5,z+.5);
          if(!pass)continue;
          const w=1-smooth(2.05,4.25,pass.lateral);
          h=lerp(h,pass.grade+.32,w);
          if(pass.lateral<2.15) lane=true;
        }
        const topSub=id===GRASS || id===LEAF || id===EARTH?EARTH:STONE;
        cols[i]={lane,sub:pack(topSub,blend(tint,topSub===EARTH?0x967451:0x99978a,.64)),deep:pack(STONE,blend(tint,0xa1a29a,.76)),h:Math.max(FLOOR+1,Math.floor(h+.18)),top:pack(id,tint),forms:forms?.[i]||null,micro:micro?.[i]||null,edits:edits?.[i]||null};
      }
      this.terrain.set(k,cols);
    }
    this.lastSampleKey=k; this.lastSample=cols;
    return cols;
  }
  column(x,z) {
    x=Math.floor(x); z=Math.floor(z);
    return this.chunkData(x>>4,z>>4)[(z&15)*16+(x&15)];
  }
  registerView(atlas,bounds) {
    this.viewAtlas=atlas;
    const minY=Math.floor(bounds.minY)-1,maxY=Math.ceil(bounds.maxY)+1;
    const xmin=Math.floor((bounds.minX-1)/16),xmax=Math.floor((bounds.maxX+1)/16);
    const zmin=Math.floor((bounds.minZ-1)/16),zmax=Math.floor((bounds.maxZ+1)/16);
    for(let z=zmin;z<=zmax;z++)for(let x=xmin;x<=xmax;x++){
      const k=key(x,z),prev=this.viewChunks.get(k);
      this.viewChunks.set(k,{lo:prev?Math.min(prev.lo,minY):minY,hi:prev?Math.max(prev.hi,maxY):maxY,cache:null});
      if(this.meshes.has(k))this.dirty.add(k);
    }
    this.lastChunk='';
  }
  async refreshView(bounds) {
    // Visible chunks already have a legacy solid mesh. Replace the affected
    // meshes before reporting a photo ready so an old foreground car or wall
    // cannot hide the first seconds of the new reconstruction.
    const loaded=[];
    for(const k of this.meshes.keys()){
      if(!this.dirty.has(k))continue;
      const [x,z]=k.split(',').map(Number),sx=x*16,sz=z*16;
      if(sx+17>=bounds.minX && sx-1<=bounds.maxX && sz+17>=bounds.minZ && sz-1<=bounds.maxZ)
        loaded.push([x,z]);
    }
    let since=performance.now();
    for(const [x,z] of loaded){
      if(!this.dirty.has(key(x,z)))continue;
      this.makeChunk(x,z);
      if(performance.now()-since>(this.budget.chunkMillis??15)){
        await new Promise(resolve=>setTimeout(resolve,0));
        since=performance.now();
      }
    }
  }
  viewCell(x,y,z) {
    if(!this.viewAtlas)return undefined;
    const rec=this.viewChunks.get(key(x>>4,z>>4));
    if(!rec || y<rec.lo || y>rec.hi)return undefined;
    const n=(y-rec.lo)*256+(z&15)*16+(x&15);
    // Key by sparse queried cells. A steep or panoramic view can span many
    // vertical levels, with only a relatively thin terrain shell to test.
    rec.cache??=new Map();
    let value=rec.cache.get(n);
    if(value===undefined) {
      const cell=this.viewAtlas.sampleCell(x,y,z);
      value=cell===undefined ? -1 : cell===0 ? 0 : pack(cell.id,cell.tint);
      rec.cache.set(n,value);
    }
    return value===-1?undefined:value;
  }
  resolvedBlock(c,x,y,z,withEdits=true,terrainMesh=false) {
    const edit=withEdits?c.edits?.get(y):undefined;
    if(edit!==undefined)return edit;
    const stamp=this.viewCell(x,y,z);
    if(stamp===undefined)return readCol(c,y,false);
    if(stamp)return terrainMesh?0:stamp; // The photo layer renders its own solids.
    if(y<FLOOR || y>=c.h)return 0;
    const rec=this.viewChunks.get(key(x>>4,z>>4)),i=(z&15)*16+(x&15);
    rec.ground??=new Array(256);
    let ground=rec.ground[i];
    if(!ground || ground.base!==c.h){
      const {height,tint}=this.viewAtlas.supportingGround(x+.5,c.h,z+.5);
      ground={base:c.h,h:Math.max(FLOOR+1,height),top:tint===undefined?c.top:pack(surfaceId(tint),tint)};
      rec.ground[i]=ground;
    }
    if(y>=ground.h)return 0;
    return y===ground.h-1?ground.top:y>=ground.h-4?c.sub:c.deep;
  }
  rawBlock(x,y,z,withEdits=true) {
    x=Math.floor(x);y=Math.floor(y);z=Math.floor(z);
    return this.resolvedBlock(this.column(x,z),x,y,z,withEdits);
  }
  getBlock(x,y,z) { return this.rawBlock(x,y,z)>>>24; }
  getGeneratedBlock(x,y,z) { return this.rawBlock(x,y,z,false)>>>24; }
  getTint(x,y,z) { return this.rawBlock(x,y,z)&0xffffff; }
  getGround(x,z) { return this.column(x,z).h; }
  belowWorld(x,y,z) {
    const area=this.viewChunks.get(key(Math.floor(x/16),Math.floor(z/16)));
    return y<Math.min(-40,area?area.lo-12:-40);
  }
  setBlock(x,y,z,id,force=false) {
    x=Math.floor(x); y=Math.floor(y); z=Math.floor(z); id=Math.trunc(id);
    if(!Number.isInteger(id) || id<0 || id>7) return false;
    if(y<FLOOR){
      const area=this.viewChunks.get(key(x>>4,z>>4));
      if(!area || y<area.lo-1 || y>area.hi+1)return false;
    }
    const col=this.column(x,z), old=this.getBlock(x,y,z);
    if(old===id && !force) return false;
    const edits=mapColumn(this.edits,x>>4,z>>4,(z&15)*16+(x&15),true);
    edits.set(y,id?solids[id-1]:0); col.edits=edits;
    const touched=new Set();
    for(let dz=-1;dz<=1;dz++) for(let dx=-1;dx<=1;dx++) touched.add(key((x+dx)>>4,(z+dz)>>4));
    for(const k of touched) this.dirty.add(k);
    this.lastChunk='';
    if(!id) {
      const details=this.details.get(key(x>>4,z>>4));
      if(details) for(const d of details) if(Math.abs(d.x-x-.5)<.85 && Math.abs(d.z-z-.5)<.85 && Math.abs(d.y-y-.5)<1.2) d.hidden=true;
    }
    return true;
  }
  makeChunk(cx,cz) {
    const k=key(cx,cz), x0=cx*16,z0=cz*16;
    const previous=this.meshes.get(k);
    if(previous) this.dropMesh(k,previous);
    const columns=new Array(18*18);
    for(let z=-1;z<=16;z++) for(let x=-1;x<=16;x++) columns[(z+1)*18+x+1]=this.column(x0+x,z0+z);
    const positions=[],normals=[],colors=[],uvs=[],indices=[],editedRanges=[];
    const stamped=this.viewChunks.has(k);
    const hasEdits=columns.some(col=>col.edits);
    const protectFace=(start,x,y,z,nx,ny,nz)=>{
      const own=columns[(z+1)*18+x+1],neighbor=columns[(nz+1)*18+nx+1];
      if(own.edits?.has(y) || neighbor.edits?.get(ny)===0)editedRanges.push(start,start+4);
    };
    const read=(x,y,z)=>{
      const col=columns[(z+1)*18+x+1]||stub;
      if(!stamped)return readCol(col,y);
      return this.resolvedBlock(col,x0+x,y,z0+z);
    };
    const covered=(x,y,z,col)=>stamped && !col.edits?.has(y) && this.viewCell(x0+x,y,z0+z)!==undefined;
    const fineMask=(col,y)=>col?.micro && !col.edits?.has(y)?col.micro.get(y):undefined;
    const halfOccupied=(x,y,z)=>{
      const col=columns[((z>>1)+1)*18+(x>>1)+1], by=y>>1;
      if(!col || !read(x>>1,by,z>>1)) return false;
      if(covered(x>>1,by,z>>1,col))return true;
      const m=fineMask(col,by);
      return m===undefined || !!(m&(1<<((x&1)+2*(y&1)+4*(z&1))));
    };
    const emitRounded=(x,y,z,raw,m)=>{
      const tint=raw&0xffffff, tile=(raw>>>24)-1;
      for(let iz=0;iz<2;iz++) for(let iy=0;iy<2;iy++) for(let ix=0;ix<2;ix++) {
        if(!(m&(1<<(ix+iy*2+iz*4)))) continue;
        const col=(m&256)&&iy===0?blend(tint,0xe0dac4,.91):tint;
        for(const f of faces) {
          const n=f.n;
          if(halfOccupied(x*2+ix+n[0],y*2+iy+n[1],z*2+iz+n[2])) continue;
          const start=positions.length/3, mult=f.s*(.988+.026*hash(x+x0,z+z0,y));
          const rr=linear[col>>16]*mult, gg=linear[(col>>8)&255]*mult, bb=linear[col&255]*mult;
          for(let i=0;i<4;i++) {
            const c=f.c[i]; positions.push(x+(ix+c[0])*.5,y+(iy+c[1])*.5,z+(iz+c[2])*.5);
            normals.push(...n); colors.push(rr,gg,bb);
            uvs.push((tile+((i===1||i===2)?.97:.03))/8,i>1?.97:.03);
          }
          if(hasEdits)protectFace(start,x,y,z,(2*x+ix+n[0])>>1,(2*y+iy+n[1])>>1,(2*z+iz+n[2])>>1);
          indices.push(start,start+1,start+2,start,start+2,start+3);
        }
      }
    };
    const emit=(x,y,z,raw)=>{
      const offset=(z+1)*18+x+1, c=columns[offset], m=fineMask(c,y);
      if(m!==undefined || fineMask(c,y-1)!==undefined || fineMask(c,y+1)!==undefined ||
         fineMask(columns[offset-1],y)!==undefined || fineMask(columns[offset+1],y)!==undefined ||
         fineMask(columns[offset-18],y)!==undefined || fineMask(columns[offset+18],y)!==undefined) {
        emitRounded(x,y,z,raw,m??255); return;
      }
      const id=raw>>>24, base=raw&0xffffff;
      const q=.976+.047*hash(x+x0,z+z0,y+id);
      for(const f of faces) {
        const n=f.n;
        if(read(x+n[0],y+n[1],z+n[2])) continue;
        const dirt=id===GRASS && n[1]===0;
        const tint=dirt?blend(0x91775b,base,.26):base;
        const tile=dirt?EARTH-1:id-1, start=positions.length/3;
        const red=linear[tint>>16],green=linear[(tint>>8)&255],blue=linear[tint&255];
        for(let i=0;i<4;i++) {
          const c=f.c[i], shade=f.ao[i];
          const a=read(x+shade[0][0],y+shade[0][1],z+shade[0][2])?1:0;
          const b=read(x+shade[1][0],y+shade[1][1],z+shade[1][2])?1:0;
          const corner=(a&&b) || read(x+shade[2][0],y+shade[2][1],z+shade[2][2])?1:0;
          const ao=1-(a+b+corner)*.065;
          const mult=q*f.s*ao;
          positions.push(x+c[0],y+c[1],z+c[2]); normals.push(...n);
          colors.push(red*mult,green*mult,blue*mult);
          uvs.push((tile+((i===1||i===2)?.97:.03))/8,i>1?.97:.03);
        }
        if(hasEdits)protectFace(start,x,y,z,x+n[0],y+n[1],z+n[2]);
        indices.push(start,start+1,start+2,start,start+2,start+3);
      }
    };
    for(let z=0;z<16;z++) for(let x=0;x<16;x++) {
      const offset=(z+1)*18+x+1, c=columns[offset];
      let lo=Math.min(c.h-1,columns[offset-1].h,columns[offset+1].h,columns[offset-18].h,columns[offset+18].h);
      if(stamped)lo=Math.min(lo,Math.max(FLOOR,this.viewChunks.get(k).lo-1));
      if(c.edits || columns[offset-1].edits || columns[offset+1].edits || columns[offset-18].edits || columns[offset+18].edits) lo=FLOOR;
      for(let y=lo;y<c.h;y++) {
        const raw=stamped?this.resolvedBlock(c,x0+x,y,z0+z,true,true):readCol(c,y);
        if(raw) emit(x,y,z,raw);
      }
      if(c.forms) for(const [y,raw] of c.forms) if(y>=c.h && !c.edits?.has(y) && !(c.lane && y<c.h+5) && !covered(x,y,z,c)) emit(x,y,z,raw);
      if(c.edits) for(const [y,raw] of c.edits) if((y>=c.h || y<FLOOR) && raw) emit(x,y,z,raw);
    }
    const group=new THREE.Group(); group.name='Chunk '+k;
    if(indices.length) {
      const geom=new THREE.BufferGeometry();
      const editMask=new Uint8Array(positions.length/3);
      for(let i=0;i<editedRanges.length;i+=2)editMask.fill(1,editedRanges[i],editedRanges[i+1]);
      geom.setAttribute('terrainEdit',new THREE.BufferAttribute(editMask,1));
      geom.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
      geom.setAttribute('normal',new THREE.Float32BufferAttribute(normals,3));
      geom.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));
      geom.setAttribute('uv',new THREE.Float32BufferAttribute(uvs,2));
      geom.setIndex(indices); geom.computeBoundingSphere();
      const mesh=new THREE.Mesh(geom,this.surfaceMaterial);
      mesh.position.set(x0,0,z0); mesh.castShadow=true; mesh.receiveShadow=true; group.add(mesh);
    }
    const passages=this.passages.get(k)||[];
    const detail=(this.details.get(k)||[]).filter(d=>{
      if(d.hidden || passages.some(route=>beamCrossesPassage(d,route)))return false;
      const e=d.m.elements;
      const halfX=(Math.abs(e[0])+Math.abs(e[4])+Math.abs(e[8]))*.5;
      const halfZ=(Math.abs(e[2])+Math.abs(e[6])+Math.abs(e[10]))*.5;
      if(Math.max(halfX,halfZ)<6)return true;
      // A long crossbeam can be owned by a neighboring chunk outside the
      // path while reaching into the walking corridor several chunks away.
      for(let x=Math.floor((d.x-halfX)/16);x<=Math.floor((d.x+halfX)/16);x++)
        for(let z=Math.floor((d.z-halfZ)/16);z<=Math.floor((d.z+halfZ)/16);z++){
          const routes=this.passages.get(key(x,z));
          if(routes?.some(route=>beamCrossesPassage(d,route)))return false;
        }
      return true;
    });
    if(detail.length) {
      const mesh=new THREE.InstancedMesh(this.unitBox,this.trimMaterial,detail.length), color=new THREE.Color();
      detail.forEach((d,i)=>{ mesh.setMatrixAt(i,d.m); mesh.setColorAt(i,color.setHex(d.c)); });
      mesh.computeBoundingSphere(); mesh.castShadow=true; mesh.receiveShadow=true; group.add(mesh);
    }
    this.group.add(group); this.meshes.set(k,group); this.dirty.delete(k);
  }
  dropMesh(k,group) {
    this.group.remove(group);
    for(const m of group.children) {
      if(m.isInstancedMesh) m.dispose();
      else m.geometry.dispose();
    }
    this.meshes.delete(k);
    const stamped=this.viewChunks.get(k);
    if(stamped)stamped.cache=null;
  }
  update(playerPos,dt) {
    this.focus=playerPos;
    const cx=Math.floor(playerPos.x/16), cz=Math.floor(playerPos.z/16), center=key(cx,cz);
    if(this.lastChunk!==center) {
      this.queue=[];
      const radius=this.budget.chunkRadius;
      for(let dz=-radius;dz<=radius;dz++) for(let dx=-radius;dx<=radius;dx++) {
        const dist=Math.hypot(dx,dz); if(dist>radius+.45) continue;
        const x=cx+dx,z=cz+dz,k=key(x,z);
        if(this.meshes.has(k) && !this.dirty.has(k)) continue;
        const forward=dx*this.forward.x+dz*this.forward.z, sideways=Math.abs(-dx*this.forward.z+dz*this.forward.x);
        const score=dist+(forward<-.8?5:0)+sideways*.1+(this.dirty.has(k)&&this.meshes.has(k)?-10:0);
        this.queue.push({x,z,score});
      }
      this.queue.sort((a,b)=>b.score-a.score);
      for(const [k,group] of this.meshes) {
        const [x,z]=k.split(',').map(Number);
        if(Math.hypot(x-cx,z-cz)>radius+1.5) this.dropMesh(k,group);
      }
      if(this.terrain.size>420) for(const k of this.terrain.keys()) {
        const [x,z]=k.split(',').map(Number); if(Math.hypot(x-cx,z-cz)>radius+4) this.terrain.delete(k);
      }
      this.lastChunk=center;
    }
    const start=performance.now(), budget=this.budget.chunkMillis??(this.meshes.size<30?15:6);
    while(this.queue.length) {
      const next=this.queue.pop(); this.makeChunk(next.x,next.z);
      if(performance.now()-start>=budget) break;
    }
  }
  dispose() {
    for(const [k,group] of this.meshes) this.dropMesh(k,group);
    this.scene.remove(this.group); this.unitBox.dispose(); this.surfaceMaterial.dispose();
    this.trimMaterial.dispose(); this.atlas.dispose(); this.terrainProjection.dispose();
    this.regions.length=0; this.queue.length=0;
    for(const index of [this.regionIndex,this.terrain,this.forms,this.micro,this.edits,this.details,this.dirty,this.passages,this.viewChunks]) index.clear();
  }
}
