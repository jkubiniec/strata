import * as THREE from './vendor/three.module.js';
import { photoDistance } from './world.js';

const sharedCube=new THREE.BoxGeometry(1,1,1);
const previews=new WeakMap();
const vertexShader=`
attribute vec3 photoSample;
attribute vec3 pigment;
uniform vec3 eye, forwardAxis, rightAxis, upAxis;
uniform vec2 aperture, lensOffset, crop, depthRange;
varying vec3 color;
void main() {
  vec2 uv=(photoSample.xy-.5)/crop+.5;
  float distance=clamp(photoSample.z,depthRange.x+.1,depthRange.y-.05);
  vec2 ray=vec2(uv.x-.5,.5-uv.y)*aperture+lensOffset;
  vec3 center=floor(eye+distance*(forwardAxis+ray.x*rightAxis+ray.y*upAxis))+.5;
  vec3 world=center+position;
  color=pow(pigment,vec3(2.2))*(normal.y>.5?1.05:normal.y<-.5?.78:abs(normal.x)>.5?.94:1.);
  gl_Position=projectionMatrix*viewMatrix*vec4(world,1.);
  if(any(lessThan(uv,vec2(0.)))||any(greaterThan(uv,vec2(1.))))gl_Position=vec4(2.,2.,2.,1.);
}`;
const fragmentShader=`
varying vec3 color;
uniform float opacity;
void main() {
  gl_FragColor=vec4(color,opacity);
  #include <colorspace_fragment>
}`;

// One small, pose-independent GPU geometry per prepared source. Repeated taps
// only set camera uniforms; source decoding and neural inference stay off the tap path.
export function prepareBankPreview(profile) {
  if(previews.has(profile))return previews.get(profile);
  const scale=Math.min(1,156/Math.max(profile.gridW,profile.gridH));
  const w=Math.max(1,Math.round(profile.gridW*scale)),h=Math.max(1,Math.round(profile.gridH*scale));
  const samples=new Float32Array(w*h*3),colors=new Uint8Array(w*h*3);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const u=(x+.5)/w,v=(y+.5)/h,i=(x+y*w)*3;
    const k=Math.floor(v*profile.gridH)*profile.gridW+Math.floor(u*profile.gridW);
    samples[i]=u;samples[i+1]=v;samples[i+2]=profile.skyMask[k]?98:photoDistance(profile.depth[k]);
    colors[i]=profile.rgb[k*3];colors[i+1]=profile.rgb[k*3+1];colors[i+2]=profile.rgb[k*3+2];
  }
  const geometry=new THREE.InstancedBufferGeometry();
  geometry.setIndex(sharedCube.index);
  geometry.setAttribute('position',sharedCube.attributes.position);
  geometry.setAttribute('normal',sharedCube.attributes.normal);
  geometry.setAttribute('photoSample',new THREE.InstancedBufferAttribute(samples,3));
  geometry.setAttribute('pigment',new THREE.InstancedBufferAttribute(colors,3,true));
  geometry.instanceCount=w*h;
  previews.set(profile,geometry);
  return geometry;
}

export function showBankPreview(game,profile,s) {
  const aspect=profile.width/profile.height;
  const material=new THREE.ShaderMaterial({vertexShader,fragmentShader,transparent:true,
    depthWrite:false,side:THREE.FrontSide,toneMapped:false,uniforms:{
      opacity:{value:.86},
      eye:{value:new THREE.Vector3(s.x,s.y,s.z)},forwardAxis:{value:new THREE.Vector3(s.dx,s.dy,s.dz)},
      rightAxis:{value:new THREE.Vector3(s.rx,s.ry,s.rz)},upAxis:{value:new THREE.Vector3(s.ux,s.uy,s.uz)},
      aperture:{value:new THREE.Vector2(s.slopeX,s.slopeY)},lensOffset:{value:new THREE.Vector2(s.offsetX||0,s.offsetY||0)},
      crop:{value:new THREE.Vector2(Math.min(1,s.aspect/aspect),Math.min(1,aspect/s.aspect))},
      depthRange:{value:new THREE.Vector2(s.near,s.far)}
    }});
  const mesh=new THREE.Mesh(prepareBankPreview(profile),material);
  mesh.name='Incoming photo voxels';mesh.frustumCulled=false;mesh.renderOrder=25;
  // A second, lighter pass reveals the parts which will replace an older,
  // nearer shell. Both passes still follow the stored 3D capture as you move.
  const behindMaterial=material.clone();
  behindMaterial.depthFunc=THREE.GreaterDepth;behindMaterial.uniforms.opacity.value=.30;
  const behind=new THREE.Mesh(mesh.geometry,behindMaterial);
  behind.name='Incoming occluded voxels';behind.frustumCulled=false;behind.renderOrder=24.5;
  game.scene.add(behind,mesh);game.drawRequested=true;
  function remove(){
    mesh.removeFromParent();behind.removeFromParent();
    material.dispose();behindMaterial.dispose();game.drawRequested=true;
  }
  return {remove,finish(){
    // The atlas begins advancing its transition after the terrain refresh.
    // Keep the preview visible until that first rendered movement, then fade.
    let fraction=1,last=performance.now();
    function fade(now){
      const elapsed=Math.min(.07,Math.max(0,(now-last)/1000));last=now;
      if(!game.viewAtlas.animating||game.viewAtlas.transitionProgress>.035)fraction-=elapsed/.42;
      if(fraction<=0){remove();return;}
      material.uniforms.opacity.value=.86*fraction;
      behindMaterial.uniforms.opacity.value=.30*fraction;
      game.drawRequested=true;requestAnimationFrame(fade);
    }
    requestAnimationFrame(fade);
  }};
}
