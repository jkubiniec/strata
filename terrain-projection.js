import * as THREE from './vendor/three.module.js';

const smooth = (low, high, value) => {
  const t = Math.min(1, Math.max(0, (value - low) / (high - low)));
  return t * t * (3 - 2 * t);
};

// Homogeneous source coordinates interpolate across each real terrain face.
// Division happens per pixel, so very close floors and walls remain aligned.
function cameraProjection(s) {
  const hx = .5 - (s.offsetX || 0) / s.slopeX;
  const hy = .5 + (s.offsetY || 0) / s.slopeY;
  const u = [s.rx / s.slopeX + hx*s.dx, s.ry / s.slopeX + hx*s.dy, s.rz / s.slopeX + hx*s.dz];
  const v = [-s.ux / s.slopeY + hy*s.dx, -s.uy / s.slopeY + hy*s.dy, -s.uz / s.slopeY + hy*s.dz];
  const d = [s.dx, s.dy, s.dz];
  const offset = row => -row[0]*s.x - row[1]*s.y - row[2]*s.z;
  return new THREE.Matrix4().set(...u,offset(u), ...v,offset(v), ...d,offset(d), 0,0,0,1);
}

const projectFragment = `
  void terrainPigment(vec3 p, vec4 settings, float travel, sampler2D source, inout vec3 pigment, inout float sum, inout float coverage) {
    if (settings.z < .001 || p.z < .07 || p.z > settings.w) return;
    vec2 uv = p.xy / p.z;
    float edge = min(min(uv.x, 1.-uv.x), min(uv.y, 1.-uv.y));
    if (edge <= 0.) return;
    // Nearby surfaces acquire large parallax first. Retire their photographic
    // detail sooner so walking past a floor never stretches a foreground subject.
    float parallax = travel / max(3.,p.z);
    float alpha = settings.z * smoothstep(0., .009, edge) * (1.-smoothstep(.025,.22,parallax));
    if (alpha < .001) return;
    // Multiple nearby capture eyes can illuminate the same surface.
    float weight = alpha * alpha;
    pigment += texture2D(source,(uv-.5)*settings.xy+.5).rgb * weight;
    sum += weight;
    coverage = max(coverage, alpha);
  }`;

export function projectionUniforms() {
  const uniforms={};
  for(const i of [0,1]){
    uniforms['terrainEye'+i]={value:new THREE.Matrix4()};
    uniforms['terrainSource'+i]={value:null};
    uniforms['terrainTravel'+i]={value:0};
    uniforms['terrainSettings'+i]={value:new THREE.Vector4(1,1,0,0)};
  }
  return uniforms;
}

// At the capture eye, each visible world-space fragment is painted by the
// original camera ray. Translating the eye progressively reveals disocclusions
// on the depth-carved voxel and Gaussian surfaces beneath that detail.
const projectionHeader=projectFragment+`
  uniform vec4 terrainSettings0,terrainSettings1;
  uniform float terrainTravel0,terrainTravel1;
  uniform sampler2D terrainSource0,terrainSource1;
  uniform mat4 terrainEye0,terrainEye1;
`;
export const surfaceProjectionGL=projectionHeader+`
  vec3 projectSurface(vec3 p, vec3 color) {
    if(terrainSettings0.z<.001)return color;
    vec3 pigment=vec3(0.);float sum=0.,coverage=0.;
    terrainPigment((terrainEye0*vec4(p,1.)).xyz,terrainSettings0,terrainTravel0,terrainSource0,pigment,sum,coverage);
    if(terrainSettings1.z>.001)
      terrainPigment((terrainEye1*vec4(p,1.)).xyz,terrainSettings1,terrainTravel1,terrainSource1,pigment,sum,coverage);
    return mix(color,pigment/max(sum,.000001),coverage);
  }`;

// Distant sky and clouds can be visible through sparse point samples. At the
// original eye those holes see the same camera ray. Release this far-field
// fallback within three blocks, before a missing surface can trail the viewer.
export const backdropProjectionGL=projectionHeader+`
  vec4 capturedBackdrop(vec3 p) {
    if(terrainSettings0.z<.001 || min(terrainTravel0,terrainTravel1)>3.)return vec4(0.);
    vec3 pigment=vec3(0.);float sum=0.,coverage=0.;
    vec4 a=terrainSettings0,b=terrainSettings1;
    a.z*=1.-smoothstep(.12,3.,terrainTravel0);b.z*=1.-smoothstep(.12,3.,terrainTravel1);
    a.w=1.e6;b.w=1.e6;
    if(a.z>.001)terrainPigment((terrainEye0*vec4(p,1.)).xyz,a,terrainTravel0,terrainSource0,pigment,sum,coverage);
    if(b.z>.001)terrainPigment((terrainEye1*vec4(p,1.)).xyz,b,terrainTravel1,terrainSource1,pigment,sum,coverage);
    return vec4(pigment/max(sum,.000001),coverage);
  }`;

export class TerrainProjection {
  constructor(material) {
    this.cameraMatrices=new WeakMap();
    this.forward=new THREE.Vector3();
    this.uniforms=projectionUniforms();
    this.originals=new Map();
    material.onBeforeCompile = shader => {
      Object.assign(shader.uniforms, this.uniforms);
      const varyings = 'varying vec3 terrainUV0,terrainUV1; varying float terrainEditable;';
      shader.vertexShader = 'attribute float terrainEdit; uniform mat4 terrainEye0,terrainEye1; uniform vec4 terrainSettings0,terrainSettings1;\n' + varyings + '\n' +
        shader.vertexShader.replace('#include <project_vertex>', `
          #include <project_vertex>
          terrainUV0=vec3(0.); terrainUV1=vec3(0.);
          if(terrainSettings0.z>.001) {
            vec4 terrainWorld=modelMatrix*vec4(transformed,1.);
            terrainUV0=(terrainEye0*terrainWorld).xyz;
            if(terrainSettings1.z>.001) terrainUV1=(terrainEye1*terrainWorld).xyz;
          }
          terrainEditable=terrainEdit;`);
      shader.fragmentShader = varyings + '\nuniform vec4 terrainSettings0,terrainSettings1; uniform float terrainTravel0,terrainTravel1; uniform sampler2D terrainSource0,terrainSource1;\n' + projectFragment + '\n' +
        shader.fragmentShader.replace('#include <opaque_fragment>', `
          if(terrainEditable < .5) {
            vec3 pigment = vec3(0.); float sum = 0., coverage = 0.;
            terrainPigment(terrainUV0, terrainSettings0, terrainTravel0, terrainSource0, pigment, sum, coverage);
            terrainPigment(terrainUV1, terrainSettings1, terrainTravel1, terrainSource1, pigment, sum, coverage);
            if(sum > .000001) outgoingLight = mix(outgoingLight, pigment/sum, coverage);
          }
          #include <opaque_fragment>`);
    };
    material.customProgramCacheKey = () => 'strata-terrain-radiance-v1';
  }

  update(camera, atlas, videoField, mode) {
    const eye = camera.position;
    camera.getWorldDirection(this.forward);
    let first, second, best = 0, runnerUp = 0;
    for (const record of atlas.stamps) {
      const layer = record.representative?.layer || record.layer, s = record.s;
      if (!layer?.resident || !layer.root.visible) continue;
      const range = (eye.x-s.x)**2 + (eye.y-s.y)**2 + (eye.z-s.z)**2;
      if (range > 144) continue;
      const facing = this.forward.x*s.dx + this.forward.y*s.dy + this.forward.z*s.dz;
      const weight = (1-smooth(0,12,Math.sqrt(range))) * Math.pow(Math.max(0,facing),4) * layer.uniforms.placement.value;
      if (weight > best || weight>0 && Math.abs(weight-best)<1e-6 && record.id===atlas.preferredCapture) {
        second=first; runnerUp=best; first=record; best=weight;
      } else if (weight > runnerUp) {
        second=record; runnerUp=weight;
      }
    }
    for(const [r,entry] of this.originals)if(r!==first && r!==second){
      entry.texture?.dispose();this.originals.delete(r);
    }
    this.setSlot(0,first,best,videoField,mode,eye,atlas);
    // At a saved camera its image should reconstruct even if another camera
    // shares the same eye. Move between them and the second ray field fades in.
    this.setSlot(1,second,runnerUp*(1-smooth(.78,1,best)),videoField,mode,eye,atlas);
  }

  originalPhoto(record,atlas){
    if(!record.neighbors?.length || !atlas.pixelsFor)return null;
    let entry=this.originals.get(record);
    if(!entry){
      entry={texture:null};this.originals.set(record,entry);
      atlas.pixelsFor(record.profile).then(image=>{
        if(this.originals.get(record)!==entry)return;
        let data=image.data;
        if(image.stride===3){
          data=new Uint8Array(image.width*image.height*4);
          for(let i=0,j=0;i<image.data.length;i+=3,j+=4){
            data[j]=image.data[i];data[j+1]=image.data[i+1];data[j+2]=image.data[i+2];data[j+3]=255;
          }
        }
        const texture=new THREE.DataTexture(data,image.width,image.height);
        texture.colorSpace=THREE.SRGBColorSpace;texture.minFilter=texture.magFilter=THREE.LinearFilter;
        texture.needsUpdate=true;entry.texture=texture;
      }).catch(()=>{});
    }
    return entry.texture;
  }

  dispose(){
    for(const entry of this.originals.values())entry.texture?.dispose();
    this.originals.clear();
  }

  setSlot(i, record, weight, videoField, mode, eye, atlas) {
    const setting = this.uniforms['terrainSettings'+i].value;
    const sampler = this.uniforms['terrainSource'+i];
    if (!record || weight < .001) {
      setting.z=0; sampler.value=null; return;
    }
    const s = record.s;
    let projection = this.cameraMatrices.get(s);
    if (!projection) { projection=cameraProjection(s); this.cameraMatrices.set(s,projection); }
    this.uniforms['terrainEye'+i].value=projection;
    this.uniforms['terrainTravel'+i].value=Math.hypot(eye.x-s.x,eye.y-s.y,eye.z-s.z);
    const clip = record.profile.video;
    const state = clip && videoField.sources.get(clip.id);
    const movie = state?.nativeReady ? state.native.texture : state?.textures?.a;
    const source=movie || this.originalPhoto(record,atlas);
    sampler.value = source || (record.representative?.layer || record.layer).texture;
    setting.set(source ? record.cropX : 1, source ? record.cropY : 1,
      weight*(mode==='voxel'?.72:1), Math.min(150,s.far));
  }
}
