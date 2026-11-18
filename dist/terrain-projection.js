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

export class TerrainProjection {
  constructor(material) {
    this.cameraMatrices = new WeakMap();
    this.forward = new THREE.Vector3();
    this.uniforms = {};
    for (const i of [0,1]) {
      this.uniforms['terrainEye'+i] = {value:new THREE.Matrix4()};
      this.uniforms['terrainSource'+i] = {value:null};
      this.uniforms['terrainTravel'+i] = {value:0};
      this.uniforms['terrainSettings'+i] = {value:new THREE.Vector4(1,1,0,0)};
    }
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
      const layer = record.layer, s = record.s;
      if (!layer?.resident || !layer.root.visible) continue;
      const range = (eye.x-s.x)**2 + (eye.y-s.y)**2 + (eye.z-s.z)**2;
      if (range > 144) continue;
      const facing = this.forward.x*s.dx + this.forward.y*s.dy + this.forward.z*s.dz;
      const weight = (1-smooth(.2,12,Math.sqrt(range))) * smooth(.28,.985,facing) * layer.uniforms.placement.value;
      if (weight > best) {
        second=first; runnerUp=best; first=record; best=weight;
      } else if (weight > runnerUp) {
        second=record; runnerUp=weight;
      }
    }
    this.setSlot(0,first,best,videoField,mode,eye);
    this.setSlot(1,second,runnerUp,videoField,mode,eye);
  }

  setSlot(i, record, weight, videoField, mode, eye) {
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
    sampler.value = movie || record.layer.texture;
    setting.set(movie ? record.cropX : 1, movie ? record.cropY : 1,
      weight*(mode==='voxel'?.78:.985), Math.min(104,s.far));
  }
}
