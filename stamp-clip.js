import * as THREE from './vendor/three.module.js';

// Trim and photographic meshes can straddle a stamp boundary. Fragment-level
// clipping leaves the original parts of a beam or image beyond the view intact.
export class StampClip {
  constructor() {
    this.frames=new Map();
    this.materials=new WeakSet();
    this.texture=null;
    this.uniforms={stampPlanes:{value:null},stampCount:{value:0},stampWidth:{value:4},
      clipToWorld:{value:new THREE.Matrix4()}};
  }
  add(frame) {
    const ox=frame.offsetX||0,oy=frame.offsetY||0;
    const values=[frame.x,frame.y,frame.z,frame.near,frame.dx,frame.dy,frame.dz,frame.far,
      frame.rx-ox*frame.dx,frame.ry-ox*frame.dy,frame.rz-ox*frame.dz,frame.slopeX*.5,
      frame.ux-oy*frame.dx,frame.uy-oy*frame.dy,frame.uz-oy*frame.dz,frame.slopeY*.5];
    // Coincident paint strokes share a clipping boundary, even if their
    // source photographs and material contributions differ.
    const key=values.join(',');
    if(this.frames.has(key))return;
    this.frames.set(key,values);
    const n=this.frames.size, w=Math.min(1024,4*n),h=Math.ceil(4*n/w);
    const data=new Float32Array(w*h*4);
    let i=0;for(const row of this.frames.values()) {data.set(row,i);i+=16;}
    this.texture?.dispose();
    this.texture=new THREE.DataTexture(data,w,h,THREE.RGBAFormat,THREE.FloatType);
    this.texture.needsUpdate=true;
    this.uniforms.stampCount.value=n;
    this.uniforms.stampWidth.value=w;
    this.uniforms.stampPlanes.value=this.texture;
  }
  update(camera) {
    camera.updateMatrixWorld();
    this.uniforms.clipToWorld.value.multiplyMatrices(camera.matrixWorld,camera.projectionMatrixInverse);
  }
  apply(material) {
    if(this.materials.has(material))return;
    this.materials.add(material);
    const compile=material.onBeforeCompile.bind(material);
    const previousKey=material.customProgramCacheKey();
    material.customProgramCacheKey=()=>previousKey+':stamp-clip';
    material.onBeforeCompile=(shader,renderer)=>{
      compile(shader,renderer);
      Object.assign(shader.uniforms,this.uniforms);
      shader.vertexShader='uniform mat4 clipToWorld; varying vec3 stampWorld;\n'+shader.vertexShader;
      const tail=shader.vertexShader.lastIndexOf('}');
      shader.vertexShader=shader.vertexShader.slice(0,tail)
        +'vec4 actual = clipToWorld * gl_Position; stampWorld=actual.xyz/actual.w;\n'+shader.vertexShader.slice(tail);
      shader.fragmentShader=`uniform sampler2D stampPlanes;
        uniform int stampCount; uniform int stampWidth; varying vec3 stampWorld;
        vec4 stampRow(int n){return texelFetch(stampPlanes,ivec2(n%stampWidth,n/stampWidth),0);}
        bool withinStamp(vec3 position) {
          for(int i=0;i<stampCount;i++){
            vec4 origin=stampRow(i*4),forward=stampRow(i*4+1);
            vec3 delta=position-origin.xyz; float d=dot(delta,forward.xyz);
            if(d<origin.w || d>forward.w)continue;
            vec4 right=stampRow(i*4+2),up=stampRow(i*4+3);
            if(abs(dot(delta,right.xyz))<=d*right.w && abs(dot(delta,up.xyz))<=d*up.w)return true;
          }
          return false;
        }
        `+shader.fragmentShader.replace(/void\s+main\s*\(\s*\)\s*\{/,match=>match+'\nif(withinStamp(stampWorld))discard;\n');
    };
    material.needsUpdate=true;
  }
  dispose(){this.texture?.dispose();this.frames.clear();}
}
