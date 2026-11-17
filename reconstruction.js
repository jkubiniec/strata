import * as THREE from './vendor/three.module.js';
import { photoVerticalSlope, photoDistance } from './world.js';

const clamp = THREE.MathUtils.clamp;
const smooth = THREE.MathUtils.smoothstep;

// The source camera has square pixels and a centered principal point. Bound
// the LONG axis for a panorama instead of distorting its aspect ratio.
export function photoFrame(profile, anchor, eyeY) {
  const aspect = profile.width / profile.height || profile.gridW / profile.gridH;
  const slopeY = photoVerticalSlope(aspect);
  return { aspect, slopeX: slopeY * aspect, slopeY, eyeY, anchor };
}

function fallbackImage(profile) {
  const {gridW,gridH,rgb}=profile;
  const canvas=document.createElement('canvas');
  canvas.width=gridW; canvas.height=gridH;
  const ctx=canvas.getContext('2d'), pixels=ctx.createImageData(gridW,gridH);
  for(let k=0;k<gridW*gridH;k++){
    pixels.data[k*4]=rgb[k*3]; pixels.data[k*4+1]=rgb[k*3+1];
    pixels.data[k*4+2]=rgb[k*3+2]; pixels.data[k*4+3]=255;
  }
  ctx.putImageData(pixels,0,0);
  return canvas;
}

// Keep the shader's texture object stable while its decoded image and GPU
// storage are evicted. Serialize large decodes when the player jumps rapidly
// between entries, dropping requests which are no longer visible.
let decodeQueue=Promise.resolve();
const emptyLayer=new THREE.BufferGeometry();
function sourceTexture(profile) {
  const texture=new THREE.Texture();
  texture.colorSpace=THREE.SRGBColorSpace;
  texture.minFilter=THREE.LinearMipmapLinearFilter;
  texture.magFilter=THREE.LinearFilter;
  let resident=false, version=0, ready=Promise.resolve();
  function retain() {
    if(resident)return ready;
    resident=true;
    const ticket=++version;
    texture.image=fallbackImage(profile);
    texture.needsUpdate=true;
    const blob=profile.imageBlob instanceof Blob ? profile.imageBlob : null;
    if(!blob && !profile.imageURL)return ready=Promise.resolve();
    ready=decodeQueue.then(async()=>{
      if(ticket!==version)return;
      const url=blob?URL.createObjectURL(blob):profile.imageURL;
      try {
        let image=new Image();
        image.src=url;
        await image.decode();
        if(ticket!==version)return;
        const w=image.naturalWidth,h=image.naturalHeight;
        // Four megapixels plus mip levels fit in ~22 MiB per source.
        const scale=Math.min(1,3072/Math.max(w,h),Math.sqrt(4194304/(w*h)));
        if(scale<1) {
          const canvas=document.createElement('canvas');
          canvas.width=Math.max(1,Math.round(w*scale));
          canvas.height=Math.max(1,Math.round(h*scale));
          const ctx=canvas.getContext('2d');
          ctx.imageSmoothingQuality='high';
          ctx.drawImage(image,0,0,canvas.width,canvas.height);
          image=canvas;
        }
        texture.dispose();
        texture.image=image;
        texture.needsUpdate=true;
      } catch (error) {
        if(ticket===version)console.warn('Using saved color samples for this photo.',error.message);
      } finally {if(blob)URL.revokeObjectURL(url);}
    });
    decodeQueue=ready;
    return ready;
  }
  function release() {
    if(!resident)return;
    version++;
    resident=false;
    texture.dispose();
    texture.image=null;
  }
  return {texture,retain,release,get resident(){return resident;},get ready(){return ready;}};
}

// Returns forward-axis depth, not length along the oblique ray. This keeps
// the occupancy field, image mesh and transition geometry in one camera frame.
function firstSurface(world, origin, dx, dy, dz, limit) {
  let x = Math.floor(origin.x), y = Math.floor(origin.y), z = Math.floor(origin.z);
  const sx = Math.sign(dx), sy = Math.sign(dy), sz = Math.sign(dz);
  const tx = dx ? Math.abs(1/dx) : Infinity;
  const ty = dy ? Math.abs(1/dy) : Infinity;
  const tz = dz ? Math.abs(1/dz) : Infinity;
  let ex = dx ? (x+(sx>0?1:0)-origin.x)/dx : Infinity;
  let ey = dy ? (y+(sy>0?1:0)-origin.y)/dy : Infinity;
  let ez = dz ? (z+(sz>0?1:0)-origin.z)/dz : Infinity;
  let t = 0;
  while (t < limit) {
    if (t > .65 && world.getBlock(x,y,z)) return t;
    if (ex < ey && ex < ez) { x+=sx; t=ex; ex+=tx; }
    else if (ey < ez) { y+=sy; t=ey; ey+=ty; }
    else { z+=sz; t=ez; ez+=tz; }
  }
  return Infinity;
}

function depthField(profile, frame, world, cols, rows) {
  const { anchor, eyeY, slopeX, slopeY } = frame;
  const origin = { x: anchor.x, y: eyeY, z: anchor.z };
  const depth = new Float32Array(cols*rows);
  const indexed = (u,v) => clamp(Math.floor(v*rows),0,rows-1)*cols + clamp(Math.floor(u*cols),0,cols-1);
  for (let j=0; j<rows; j++) {
    for (let i=0; i<cols; i++) {
      const u = (i+.5)/cols, v = (j+.5)/rows;
      const k = Math.min(profile.gridH-1,Math.floor(v*profile.gridH))*profile.gridW
        + Math.min(profile.gridW-1,Math.floor(u*profile.gridW));
      const isSky = !!profile.skyMask[k];
      let d = isSky ? 138 : photoDistance(profile.depth[k] || 0);
      if (world && !isSky) {
        const side = (u-.5)*slopeX, up = (.5-v)*slopeY;
        const hit = firstSurface(world, origin, anchor.dx-side*anchor.dz, up, anchor.dz+side*anchor.dx, d+1);
        // Face registration is strongest for the near floor. In ambiguous
        // object interiors retain the learned depth rather than wrapping a
        // photograph around unrelated generated landmark geometry.
        if (hit < d+1 && (v>.55 || Math.abs(hit-d)<Math.max(4,d*.18))) d = Math.min(d,Math.max(.75,hit-.09));
      }
      depth[j*cols+i] = d;
    }
  }
  return { depth, at:(u,v)=>depth[indexed(u,v)] };
}

const vertexShader = `
  attribute vec3 sourceProjection;
  varying vec3 vSource;
  varying vec3 vPosition;
  void main() {
    vSource = sourceProjection;
    vPosition = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.);
  }
`;

const fragmentShader = `
  uniform sampler2D photo;
  uniform sampler2D cutouts;
  uniform vec2 cells;
  uniform float alpha;
  uniform float faceting;
  uniform float cameraPriority;
  varying vec3 vSource;
  varying vec3 vPosition;
  void main() {
    vec2 uv=clamp(vSource.xy/vSource.z,vec2(0.),vec2(1.));
    if (texture2D(cutouts,uv).r < .5) discard;
    vec3 source = texture2D(photo,uv).rgb;
    vec2 tile = (floor(uv*cells)+.5)/cells;
    vec3 voxel = texture2D(photo,tile).rgb;
    vec3 n = normalize(cross(dFdx(vPosition),dFdy(vPosition)));
    float shade=.85+.15*abs(n.y)+.08*abs(n.x);
    vec3 color=mix(source,voxel*shade,faceting);
    if (!gl_FrontFacing) color *= 1.-.14*faceting;
    // Other procedural geometry can cross a thin source surface. Favor the
    // registered capture near its optical center, relaxing to normal scene
    // depth as the eye moves away. Parallax uses the true vertex positions.
    gl_FragDepth = gl_FragCoord.z*(1.-.075*cameraPriority);
    gl_FragColor=vec4(color,alpha);
    #include <colorspace_fragment>
  }
`;

function makeLayer(frame, cols, rows, depths) {
  const { slopeX, slopeY } = frame;
  const positions=[], projection=[], indices=[];
  const depth=(i,j)=>depths[clamp(j,0,rows-1)*cols+clamp(i,0,cols-1)];
  const similar=(a,b)=>Math.abs(a-b)<Math.max(.6,Math.min(a,b)*.105);
  // Each edge-aware cell covers exactly its original angular rectangle. At
  // a discontinuity the two neighboring cells keep independent z values,
  // so translating the eye reveals an occlusion instead of a stretched face.
  function vertex(u,v,d,sourceU,sourceV) {
    positions.push((u-.5)*slopeX*d,(.5-v)*slopeY*d,-d);
    projection.push(sourceU*d,(1-sourceV)*d,d);
  }
  function cornerDepth(i,j,center) {
    let sum=0,n=0;
    for(let y=j-1;y<=j;y++) for(let x=i-1;x<=i;x++) {
      const d=depth(x,y);
      if(similar(center,d)) {sum+=d; n++;}
    }
    return n?sum/n:center;
  }
  const quad=(base)=>indices.push(base,base+2,base+1,base,base+3,base+2);
  for (let j=0;j<rows;j++) for (let i=0;i<cols;i++) {
    const d=depth(i,j), base=positions.length/3;
    for (const [x,y] of [[i,j],[i+1,j],[i+1,j+1],[i,j+1]]) {
      const u=x/cols,v=y/rows;
      vertex(u,v,cornerDepth(x,y,d),u,v);
    }
    quad(base);
    // Extend the color of the FAR side underneath the near side. These
    // ribbons are hidden at capture and reveal local color behind a silhouette.
    for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      if(i+dx<0||i+dx>=cols||j+dy<0||j+dy>=rows)continue;
      const near=depth(i+dx,j+dy);
      if(d-near<Math.max(1.4,near*.16))continue;
      const width=Math.min(4.5,1.2+(d-near)/12);
      const l=(i+(dx>0?1:dx<0?-width:0))/cols, r=(i+(dx>0?1+width:dx<0?0:1))/cols;
      const top=(j+(dy>0?1:dy<0?-width:0))/rows, bottom=(j+(dy>0?1+width:dy<0?0:1))/rows;
      const edgeBase=positions.length/3;
      for(const [u,v] of [[l,top],[r,top],[r,bottom],[l,bottom]]) {
        const su=dx?(i+.5)/cols:u, sv=dy?(j+.5)/rows:v;
        vertex(u,v,d+.28,su,sv);
      }
      quad(edgeBase);
    }
  }
  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
  geometry.setAttribute('sourceProjection',new THREE.Float32BufferAttribute(projection,3));
  geometry.setIndex(indices);geometry.computeBoundingSphere();
  return geometry;
}

/** A depth-layered photographic surface in the same register as editable voxels. */
export async function createPhotoSurface(profile, anchor, eyeY, world=null, preload=true) {
  const frame=photoFrame(profile,anchor,eyeY);
  const {aspect,slopeX,slopeY}=frame;
  const target=clamp(Math.round(78+72*(profile.detail??.5)),32,150);
  const cols=Math.max(2,Math.min(profile.gridW,Math.round(target*Math.min(1,aspect))));
  const rows=Math.max(2,Math.min(profile.gridH,Math.round(target*Math.min(1,1/aspect))));
  const {depth,at}=depthField(profile,frame,world,cols,rows);
  let geometry=null;
  const source=sourceTexture(profile), texture=source.texture;
  const mw=Math.max(8,Math.min(384,cols*3)), mh=Math.max(8,Math.min(384,rows*3));
  const cut=new Uint8Array(mw*mh).fill(255);
  const cutouts=new THREE.DataTexture(cut,mw,mh,THREE.RedFormat);
  cutouts.needsUpdate=true;
  const cutCounts=new Uint16Array(cut.length), editedCells=new Map();
  const uniforms={
    photo:{value:texture},cutouts:{value:cutouts},alpha:{value:1},
    cells:{value:new THREE.Vector2(cols*.82,rows*.82)},faceting:{value:0},cameraPriority:{value:1}
  };
  const material=new THREE.ShaderMaterial({
    vertexShader,fragmentShader,uniforms,side:THREE.DoubleSide,
    transparent:true,depthTest:true,depthWrite:true,toneMapped:false,
    forceSinglePass:true
  });
  const mesh=new THREE.Group();
  mesh.name='Depth-layered source photograph';
  mesh.position.set(anchor.x,eyeY,anchor.z);
  mesh.rotation.y=Math.atan2(-anchor.dx,-anchor.dz);
  mesh.visible=false;
  const surface=new THREE.Mesh(emptyLayer,material);
  surface.renderOrder=20;
  mesh.add(surface);
  function retain() {
    if(!source.resident)cutouts.needsUpdate=true;
    return source.retain();
  }
  function release() {
    mesh.visible=false;
    if(!source.resident)return;
    surface.geometry=emptyLayer;
    geometry?.dispose(); geometry=null;
    source.release(); cutouts.dispose();
  }
  if(preload)await retain();
  return {
    mesh,texture,cutouts,frame,count:cols*rows,depthAt:at,retain,release,
    get resident(){return source.resident;}, get ready(){return source.ready;},
    setAppearance(mode,splats,visibility,displacement=0) {
      const weight=clamp(visibility??1,0,1);
      const intensity=clamp(splats??.65,0,1);
      mesh.visible=source.resident && mode==='hybrid' && weight>.004 && intensity>0;
      if(!mesh.visible)return;
      if(!geometry){geometry=makeLayer(frame,cols,rows,depth);surface.geometry=geometry;}
      uniforms.alpha.value=weight*clamp(intensity/.55,0,1);
      uniforms.cameraPriority.value=1-smooth(displacement,.2,5.5);
      uniforms.faceting.value=.62*smooth(displacement,.6,13);
      material.depthWrite=uniforms.alpha.value>.95;
    },
    maskCell(x,y,z) {
      const key=x+','+y+','+z;
      const altered=!world?.getGeneratedBlock || world.getBlock(x,y,z)!==world.getGeneratedBlock(x,y,z);
      const previous=editedCells.get(key);
      if(!altered) {
        if(!previous)return;
        for(const i of previous){if(--cutCounts[i]===0)cut[i]=255;}
        editedCells.delete(key);cutouts.needsUpdate=true;return;
      }
      if(previous)return;
      const wx=x+.5-anchor.x,wz=z+.5-anchor.z;
      const distance=wx*anchor.dx+wz*anchor.dz;
      if(distance<=.25)return;
      const u=.5+(-wx*anchor.dz+wz*anchor.dx)/(slopeX*distance), v=.5-(y+.5-eyeY)/(slopeY*distance);
      const rx=(.84+Math.abs(u-.5)*.75)/(Math.max(.6,distance-.76)*slopeX);
      const ry=(.84+Math.abs(v-.5)*.75)/(Math.max(.6,distance-.76)*slopeY);
      if(u+rx<0 || u-rx>1 || v+ry<0 || v-ry>1)return;
      const l=clamp(Math.floor((u-rx)*mw),0,mw),r=clamp(Math.ceil((u+rx)*mw),0,mw);
      const t=clamp(Math.floor((1-v-ry)*mh),0,mh),b=clamp(Math.ceil((1-v+ry)*mh),0,mh);
      const pixels=[];
      const safe=d=>Math.abs(d)<1e-8 ? (d<0?-1e-8:1e-8):d;
      for(let j=t;j<b;j++) for(let i=l;i<r;i++){
        const su=(i+.5)/mw,sv=1-(j+.5)/mh;
        const side=(su-.5)*slopeX,dy=(.5-sv)*slopeY;
        const dx=anchor.dx-side*anchor.dz,dz=anchor.dz+side*anchor.dx;
        // Slab intersection trims the projected bounding rectangle to the
        // actual cube silhouette, keeping the photo visible around an edit.
        const ax=(x-anchor.x)/safe(dx),bx=(x+1-anchor.x)/safe(dx);
        const ay=(y-eyeY)/safe(dy),by=(y+1-eyeY)/safe(dy);
        const az=(z-anchor.z)/safe(dz),bz=(z+1-anchor.z)/safe(dz);
        const enter=Math.max(0,Math.min(ax,bx),Math.min(ay,by),Math.min(az,bz));
        const exit=Math.min(Math.max(ax,bx),Math.max(ay,by),Math.max(az,bz));
        if(enter>exit || enter>at(su,sv)+1.5)continue;
        const n=j*mw+i;pixels.push(n);cutCounts[n]++;cut[n]=0;
      }
      if(!pixels.length)return;
      editedCells.set(key,pixels);
      cutouts.needsUpdate=true;
    },
    dispose(){release();material.dispose();}
  };
}
