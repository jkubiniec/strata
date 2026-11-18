import * as THREE from './vendor/three.module.js';
import { AdaptiveRaster, desktopBudget, isMobileRenderer, phoneBudget } from './performance-profile.js';
import { correspondence, createMorphField, MorphEditVolume } from './morph.js';
import { createPhotoSurface } from './reconstruction.js';
import { ViewVolumeAtlas, cameraStamp, captureStamp } from './view-volume.js';
import { StampClip } from './stamp-clip.js';
import { VideoField } from './video-field.js';
import {backdropProjectionGL} from './terrain-projection.js';
import { BLOCKS, VoxelWorld, photoVerticalSlope, PHOTO_HORIZON, photoDistance } from './world.js';

const clamp = THREE.MathUtils.clamp;
const smooth = THREE.MathUtils.smoothstep;
const radians = Math.PI / 180;
const eyeHeight = 1.66;
const bodyHeight = 1.8;
const bodyRadius = 0.285;
const epsilon = 0.0001;
const controls = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyI', 'KeyJ', 'KeyK', 'KeyL', 'ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight', 'Space', 'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'KeyQ', 'KeyC']);
const north = { x: 0, z: 0, dx: 0, dz: -1 };

function randomStream(seed) {
  let state = (Number(seed) || 36127) >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

// Distance along the new camera direction needed to clear an old scene's
// central landmarks. Project both oriented footprints onto their four
// separating axes so a side branch can attach close to an existing region.
function clearance(anchor, old) {
  const dx = anchor.x+50*anchor.dx - (old.x+37.5*old.dx);
  const dz = anchor.z+50*anchor.dz - (old.z+37.5*old.dz);
  const axes = [[anchor.dx,anchor.dz],[-anchor.dz,anchor.dx],[old.dx,old.dz],[-old.dz,old.dx]];
  let exit = Infinity;
  for (const [ax,az] of axes) {
    const velocity = ax*anchor.dx+az*anchor.dz, position = ax*dx+az*dz;
    const radius = 56*Math.abs(velocity) + 65*Math.abs(-ax*anchor.dz+az*anchor.dx)
      + 42.5*Math.abs(ax*old.dx+az*old.dz) + 47*Math.abs(-ax*old.dz+az*old.dx);
    if (Math.abs(position) >= radius) return 0;
    if (Math.abs(velocity) > epsilon) exit = Math.min(exit,(Math.sign(velocity)*radius-position)/velocity);
  }
  return exit+5;
}

// Amanatides–Woo traversal. The entry normal also identifies the empty
// neighbor where a placed block belongs.
export function traceVoxels(world, ox, oy, oz, dx, dy, dz, maxDistance) {
  let x = Math.floor(ox), y = Math.floor(oy), z = Math.floor(oz);
  const sx = Math.sign(dx), sy = Math.sign(dy), sz = Math.sign(dz);
  const tx = dx ? Math.abs(1 / dx) : Infinity;
  const ty = dy ? Math.abs(1 / dy) : Infinity;
  const tz = dz ? Math.abs(1 / dz) : Infinity;
  let nextX = dx ? (dx > 0 ? x + 1 - ox : ox - x) * tx : Infinity;
  let nextY = dy ? (dy > 0 ? y + 1 - oy : oy - y) * ty : Infinity;
  let nextZ = dz ? (dz > 0 ? z + 1 - oz : oz - z) * tz : Infinity;
  let distance = 0, nx = 0, ny = 0, nz = 0;
  while (distance <= maxDistance) {
    const id = world.getBlock(x, y, z);
    if (id) return { x, y, z, id, nx, ny, nz, distance };
    if (nextX <= nextY && nextX <= nextZ) {
      distance = nextX;
      nextX += tx;
      x += sx;
      nx = -sx; ny = 0; nz = 0;
    } else if (nextY <= nextZ) {
      distance = nextY;
      nextY += ty;
      y += sy;
      nx = 0; ny = -sy; nz = 0;
    } else {
      distance = nextZ;
      nextZ += tz;
      z += sz;
      nx = 0; ny = 0; nz = -sz;
    }
  }
  return null;
}

function skyColors(profile, first) {
  const sum = [0, 0, 0];
  let n = 0;
  for (let i = 0; i < profile.skyMask.length; i += 3) {
    if (!profile.skyMask[i]) continue;
    for (let c = 0; c < 3; c++) sum[c] += profile.rgb[i * 3 + c];
    n++;
  }
  const sampled = new THREE.Color('#9cb8bb');
  if (n) sampled.setRGB(sum[0] / n / 255, sum[1] / n / 255, sum[2] / n / 255, THREE.SRGBColorSpace);
  const top = new THREE.Color('#639ed1').lerp(sampled, first ? 0.14 : 0.68);
  const horizon = new THREE.Color('#dce5d8').lerp(sampled, first ? 0.15 : 0.39);
  return { top, horizon };
}

function createSky(projection) {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      ...projection,
      topColor: { value: new THREE.Color('#78afca') },
      horizonColor: { value: new THREE.Color('#e1e4d5') }
    },
    vertexShader: `
      varying vec3 vRay,vSkyWorld;
      void main() {
        vRay = position;vSkyWorld=(modelMatrix*vec4(position,1.)).xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.);
      }
    `,
    fragmentShader: backdropProjectionGL+`
      uniform vec3 topColor;
      uniform vec3 horizonColor;
      varying vec3 vRay,vSkyWorld;
      void main() {
        vec3 ray = normalize(vRay);
        float height = pow(clamp(ray.y * 1.52 + .017, 0., 1.), .63);
        vec3 color = mix(horizonColor, topColor, height);
        float sun = max(dot(ray, normalize(vec3(-.72,.82,.34))), 0.);
        color += vec3(.1,.072,.036) * pow(sun, 10.);
        vec4 capture=capturedBackdrop(vSkyWorld);
        gl_FragColor = vec4(mix(color,capture.rgb,capture.a), 1.);
        #include <colorspace_fragment>
      }
    `,
    side: THREE.BackSide, depthTest: false, depthWrite: false
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(375, 24, 16), material);
  sky.renderOrder = -100;
  sky.frustumCulled = false;
  return sky;
}

function createClouds(projection) {
  const random = randomStream(8411);
  const transforms = [];
  // Low, gently stepped cloud banks. The whole cloud field follows the sky;
  // the small translation gives the clouds subtle, distant parallax.
  for (let bank = 0; bank < 42; bank++) {
    const angle = random() * Math.PI * 2;
    const distance = 140 + random() * 180;
    const x = Math.sin(angle) * distance, z = Math.cos(angle) * distance;
    const y = 45 + random() * 58;
    const pieces = 2 + Math.floor(random() * 5);
    for (let cell = 0; cell < pieces; cell++) {
      transforms.push([
        x + (cell - pieces / 2) * 6, y + Math.floor(random() * 2) * 0.8,
        z + Math.round((random() - .5) * 2) * 4,
        11 + random() * 14, 1.1 + random() * 1.8, 4 + random() * 8
      ]);
    }
  }
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const material = new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true, fog: true });
  material.onBeforeCompile=shader=>{
    Object.assign(shader.uniforms,projection);
    shader.vertexShader='varying vec3 cloudWorld;\n'+shader.vertexShader.replace('#include <project_vertex>',
      '#include <project_vertex>\ncloudWorld=(modelMatrix*instanceMatrix*vec4(transformed,1.)).xyz;');
    shader.fragmentShader='varying vec3 cloudWorld;\n'+backdropProjectionGL+shader.fragmentShader.replace('#include <fog_fragment>',`
      #include <fog_fragment>
      vec4 capture=capturedBackdrop(cloudWorld);
      gl_FragColor.rgb=mix(gl_FragColor.rgb,linearToOutputTexel(vec4(capture.rgb,1.)).rgb,capture.a);`);
  };
  const colors = [], normal = geometry.attributes.normal;
  for (let i = 0; i < normal.count; i++) {
    const color = new THREE.Color(normal.getY(i) < -.5 ? '#d2dad4' : normal.getY(i) > .5 ? '#f6f7e9' : '#e5e9db');
    colors.push(color.r, color.g, color.b);
  }
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  const clouds = new THREE.InstancedMesh(geometry, material, transforms.length);
  const matrix = new THREE.Matrix4();
  transforms.forEach(([x, y, z, w, h, d], i) => {
    matrix.makeScale(w, h, d).setPosition(x, y, z);
    clouds.setMatrixAt(i, matrix);
  });
  clouds.frustumCulled = false;
  return clouds;
}

const splatVertex = `
  uniform sampler2D records;
  uniform vec2 viewport;
  uniform float hybrid;
  uniform float intensity;
  uniform float visibility;
  uniform vec3 fogColor;
  attribute float splatId;
  varying vec2 vGaussian;
  varying vec3 vColor;
  varying float vOpacity;
  vec2 projectAxis(vec3 p, vec3 a) {
    float invDepth = 1. / max(.05, -p.z);
    return .5 * viewport * vec2(projectionMatrix[0][0], projectionMatrix[1][1])
      * (a.xy + p.xy * a.z * invDepth) * invDepth;
  }
  void main() {
    int offset = int(splatId + .5) * 4;
    ivec2 uv = ivec2(offset % 256, offset / 256);
    vec4 center = texelFetch(records, uv, 0);
    vec4 tangent = texelFetch(records, uv + ivec2(1,0), 0);
    vec4 bitangent = texelFetch(records, uv + ivec2(2,0), 0);
    vec3 color = texelFetch(records, uv + ivec2(3,0), 0).rgb;
    vec3 p = (modelViewMatrix * vec4(center.xyz, 1.)).xyz;
    vGaussian = position.xy;
    vOpacity = center.w * mix(1., tangent.w, hybrid) * intensity * visibility;
    if (p.z > -.14 || vOpacity < .002) {
      gl_Position = vec4(2.,2.,2.,1.);
      return;
    }
    mat3 rot = mat3(modelViewMatrix);
    vec3 n = cross(tangent.xyz, bitangent.xyz);
    n *= bitangent.w / max(length(n), .00001);
    vec2 a = projectAxis(p, rot * tangent.xyz);
    vec2 b = projectAxis(p, rot * bitangent.xyz);
    vec2 c = projectAxis(p, rot * n);
    // Screen-space covariance J W Sigma W' J'. Diagonalizing this
    // two-by-two matrix gives the ellipse axes and projected variances.
    float xx = a.x*a.x + b.x*b.x + c.x*c.x + .22;
    float xy = a.x*a.y + b.x*b.y + c.x*c.y;
    float yy = a.y*a.y + b.y*b.y + c.y*c.y + .22;
    float mid = .5 * (xx + yy);
    float delta = length(vec2(.5 * (xx - yy), xy));
    float high = mid + delta;
    float low = max(.15, mid - delta);
    vec2 axis = abs(xy) > .00001 ? normalize(vec2(xy, high - xx))
      : (xx >= yy ? vec2(1.,0.) : vec2(0.,1.));
    vec2 pixels = axis * position.x * min(sqrt(high), 110.)
      + vec2(-axis.y,axis.x) * position.y * min(sqrt(low), 84.);
    vec4 clip = projectionMatrix * vec4(p, 1.);
    clip.xy += (2. * pixels / viewport) * clip.w;
    gl_Position = clip;
    float fog = 1. - exp(-.000020 * p.z * p.z);
    vColor = mix(color, fogColor, min(.85, fog));
  }
`;
const splatFragment = `
  varying vec2 vGaussian;
  varying vec3 vColor;
  varying float vOpacity;
  void main() {
    float r = dot(vGaussian,vGaussian);
    if (r > 6.25) discard;
    float alpha = vOpacity * exp(-.5*r);
    if (alpha < .004) discard;
    gl_FragColor = vec4(vColor, min(.99, alpha));
    #include <colorspace_fragment>
  }
`;

function registerSurface(world, anchor, eyeY, aspect, sensorSlope, compact) {
  const cols = compact?31:51, rows = compact?23:35;
  const distance = new Float32Array(cols * rows);
  const tint = new Uint32Array(cols * rows);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const side = (i / (cols - 1) - .5) * 2 * sensorSlope * aspect;
      const up = (PHOTO_HORIZON - j / (rows - 1)) * 2 * sensorSlope;
      const dx = anchor.dx - anchor.dz * side, dz = anchor.dz + anchor.dx * side;
      const length = Math.hypot(dx, up, dz);
      const hit = traceVoxels(world, anchor.x, eyeY, anchor.z, dx / length, up / length, dz / length, 112 * length);
      distance[j * cols + i] = hit && hit.distance > 3 ? hit.distance / length : 0;
      if (hit) tint[j*cols+i] = world.getTint(hit.x,hit.y,hit.z);
    }
  }
  return { distance, tint, index: (u,v) => Math.round(v*(rows-1))*cols+Math.round(u*(cols-1)) };
}

function makeSplatField(world, profile, anchor, starter, viewport, fogColor, compact=false) {
  const gw = profile.gridW, gh = profile.gridH;
  const aspect = profile.width / profile.height || gw / gh;
  const sensorSlope = photoVerticalSlope(aspect) / 2;
  const w = Math.min(gw, Math.round((compact?70:130) + (compact?63:211) * (profile.detail ?? .6)));
  const h = Math.min(gh, Math.max(1, Math.round(w * gh / gw)));
  const eyeY = world.getGround(anchor.x, anchor.z) + eyeHeight;
  const surface = registerSurface(world, anchor, eyeY, aspect, sensorSlope, compact);
  const depths = new Float32Array(w * h);
  const attached = new Float32Array(w * h);
  const pixels = new Int32Array(w * h);
  const data = [], centers = [];
  const random = randomStream(profile.seed);
  const color = new THREE.Color();
  const linear = Array.from({ length: 256 }, (_, v) => color.setRGB(v/255, 0, 0, THREE.SRGBColorSpace).r);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const u = (i + .5) / w, v = (j + .5) / h;
      const p = Math.min(gh - 1, Math.floor(v * gh)) * gw + Math.min(gw - 1, Math.floor(u * gw));
      const idx = j*w+i;
      pixels[idx] = p;
      if (profile.skyMask[p]) continue;
      const estimate = photoDistance(profile.depth[p]);
      const cell = surface.index(u,v);
      const measured = surface.distance[cell];
      // Keep the source-image ray, but register the photo relief to local
      // geometry where monocular depth and the voxel surface agree.
      const agreement = measured ? 1 - smooth(Math.abs(measured - estimate), 5, 41) : 0;
      const tint = surface.tint[cell];
      const chromaDistance = Math.hypot(profile.rgb[p*3]-((tint>>16)&255),
        profile.rgb[p*3+1]-((tint>>8)&255),profile.rgb[p*3+2]-(tint&255));
      const colorAgreement = 1-smooth(chromaDistance,39,175);
      const snap = measured && (starter || agreement > .48);
      depths[idx] = snap ? Math.max(3, measured - .24) : estimate;
      attached[idx] = snap ? (starter ? .025 + agreement * .067 : .025 + agreement * colorAgreement * .58) : (starter ? .003 : .012);
    }
  }
  const emit = (u, v, d, ddx, ddy, p, opacity, hybridAlpha, scale) => {
    const side = (u-.5)*2*sensorSlope*aspect, up = (PHOTO_HORIZON-v)*2*sensorSlope;
    const rx = -anchor.dz, rz = anchor.dx;
    const dx = anchor.dx + rx*side, dz = anchor.dz + rz*side;
    const x = anchor.x + dx*d, y = eyeY + up*d, z = anchor.z + dz*d;
    const sw = d * 2 * sensorSlope * aspect / w * scale;
    const sh = d * 2 * sensorSlope / h * scale;
    const ddU = clamp(ddx, -sw*2.7, sw*2.7) * .48;
    const ddV = clamp(ddy, -sh*2.7, sh*2.7) * .48;
    centers.push(x,y,z);
    data.push(
      x,y,z,opacity,
      rx*sw + dx*ddU, up*ddU, rz*sw + dz*ddU, hybridAlpha,
      dx*ddV, -sh + up*ddV, dz*ddV, Math.min(sw, sh)*.24,
      linear[profile.rgb[p*3]],linear[profile.rgb[p*3+1]],linear[profile.rgb[p*3+2]],1
    );
  };
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const idx = j*w+i, d = depths[idx];
      if (!d) continue;
      const u = (i+.5)/w, v = (j+.5)/h;
      const right = i+1 < w ? idx+1 : idx, below = j+1 < h ? idx+w : idx;
      const ddx = depths[right] ? depths[right]-d : 0, ddy = depths[below] ? depths[below]-d : 0;
      emit(u,v,d,ddx,ddy,pixels[idx],.91,attached[idx],.69);
      // A second, farther Gaussian carries the far-side color into newly
      // revealed space around source-image depth edges as the camera moves.
      const neighbors = [right, below, i ? idx-1 : idx, j ? idx-w : idx];
      let far = idx;
      for (const n of neighbors) if (depths[n] > depths[far]) far = n;
      const gap = depths[far]-d;
      if (gap > Math.max(3.1, d*.095) && random() < .82) {
        const du = ((far % w) - i) / w, dv = (Math.floor(far/w) - j) / h;
        emit(u-du*.28,v-dv*.28,depths[far]+.35+random()*.8,0,0,pixels[far],.71,attached[far]*.38,1.02);
      }
    }
  }
  // Continue sampled materials around the camera and behind the reconstructed
  // photo, so the Gaussian-only view has a walkable, colored world outside
  // the source image's field of view. These surfels use voxel surface colors,
  // with the same world-space covariance and depth sorting as photo samples.
  const tile = compact?3:1.95;
  const support = (u,v,y,col,normal,opacity) => {
    const x = anchor.x - anchor.dz*u + anchor.dx*v, z = anchor.z + anchor.dx*u + anchor.dz*v;
    if (v>1) {
      const screenU = .5 + u/(v*2*sensorSlope*aspect);
      const screenV = PHOTO_HORIZON - (y-eyeY)/(v*2*sensorSlope);
      if (screenU>=0 && screenU<1 && screenV>=0 && screenV<1) {
        const d = depths[Math.floor(screenV*h)*w+Math.floor(screenU*w)];
        // Give the registered photo surface priority along its original rays.
        if (d && v < d+1.2) return;
      }
    }
    const scale = tile * (.76 + random()*.1), light = .91 + random()*.13;
    const r = linear[(col>>16)&255]*light, g = linear[(col>>8)&255]*light, b = linear[col&255]*light;
    centers.push(x,y,z);
    const tangent = normal ? [0,scale*.91,0] : [-anchor.dz*scale,0,anchor.dx*scale];
    const bitangent = normal ? [normal[0]*scale,0,normal[1]*scale] : [anchor.dx*scale,0,anchor.dz*scale];
    data.push(x,y,z,opacity,...tangent,0,...bitangent,.1,r,g,b,1);
  };
  for (let v = -51; v < 115; v += tile) {
    for (let u = -83; u < 83; u += tile) {
      const du = u + (random()-.5)*tile*.27, dv = v + (random()-.5)*tile*.27;
      const x = Math.floor(anchor.x-anchor.dz*du+anchor.dx*dv);
      const z = Math.floor(anchor.z+anchor.dx*du+anchor.dz*dv);
      const ground = world.getGround(x,z);
      support(du,dv,ground+.025,world.getTint(x,ground-1,z),null,.9);
      if (dv<6 || Math.abs(du)>72) continue;
      let roof = ground+40;
      while (roof>=ground && !world.getBlock(x,roof,z)) roof--;
      if (roof<=ground) continue;
      support(du,dv,roof+1,world.getTint(x,roof,z),null,.88);
      for (let y = roof-1; y>=ground; y-=tile) {
        const by = Math.floor(y);
        if (!world.getBlock(x,by,z)) continue;
        const col = world.getTint(x,by,z);
        if (!world.getBlock(x+1,by,z) || !world.getBlock(x-1,by,z)) support(du,dv,y+.5,col,[0,1],.8);
        else if (!world.getBlock(x,by,z+1) || !world.getBlock(x,by,z-1)) support(du,dv,y+.5,col,[1,0],.8);
      }
    }
  }
  return gaussianMesh(data,centers,viewport,fogColor);
}

function gaussianMesh(data,centers,viewport,fogColor) {
  const count = centers.length / 3;
  const height = Math.max(1, Math.ceil(count * 4 / 256));
  const texels = new Float32Array(256 * height * 4);
  texels.set(data);
  const texture = new THREE.DataTexture(texels, 256, height, THREE.RGBAFormat, THREE.FloatType);
  texture.minFilter = texture.magFilter = THREE.NearestFilter;
  texture.needsUpdate = true;
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([-2.5,-2.5,0,2.5,-2.5,0,2.5,2.5,0,-2.5,2.5,0],3));
  geometry.setIndex([0,1,2,0,2,3]);
  const ids = Float32Array.from({ length: count }, (_, i) => i);
  const order = new THREE.InstancedBufferAttribute(ids, 1);
  order.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('splatId', order);
  geometry.instanceCount = count;
  const material = new THREE.ShaderMaterial({
    uniforms: {
      records: { value: texture }, viewport: { value: viewport },
      hybrid: { value: 1 }, intensity: { value: .65 }, visibility: { value: 1 },
      fogColor: { value: fogColor }
    }, vertexShader: splatVertex, fragmentShader: splatFragment,
    transparent: true, depthWrite: false, depthTest: true
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'Photo Gaussian field';
  mesh.frustumCulled = false;
  const positions = new Float32Array(centers);
  const bounds = new THREE.Box3().setFromArray(positions);
  let buckets;
  const bucketKey = (x,y,z) => x+','+y+','+z;
  const sortDepth = new Float32Array(count);
  const lastDirection = new THREE.Vector3(Infinity,Infinity,Infinity);
  let resident = false;
  return {
    mesh, count, created: performance.now(),
    maskCell(x,y,z) {
      if (x-1>bounds.max.x || x+2<bounds.min.x || y-1>bounds.max.y || y+2<bounds.min.y || z-1>bounds.max.z || z+2<bounds.min.z) return;
      if (!buckets) {
        buckets = new Map();
        for (let i=0; i<count; i++) {
          const key = bucketKey(Math.floor(positions[3*i]/5),Math.floor(positions[3*i+1]/5),Math.floor(positions[3*i+2]/5));
          if (!buckets.has(key)) buckets.set(key,[]);
          buckets.get(key).push(i);
        }
      }
      let changed = false;
      for (let bz=Math.floor((z-.3)/5); bz<=Math.floor((z+1.3)/5); bz++)
        for (let by=Math.floor((y-.3)/5); by<=Math.floor((y+1.3)/5); by++)
          for (let bx=Math.floor((x-.3)/5); bx<=Math.floor((x+1.3)/5); bx++) {
            for (const i of buckets.get(bucketKey(bx,by,bz)) || []) {
              const px=positions[i*3],py=positions[i*3+1],pz=positions[i*3+2];
              if (px<x-.3 || px>x+1.3 || py<y-.3 || py>y+1.3 || pz<z-.3 || pz>z+1.3) continue;
              texels[i*16+3]=0;
              changed=true;
            }
          }
      if (changed) texture.needsUpdate=true;
    },
    sort(direction) {
      if (!resident) {
        texture.needsUpdate = true;
        resident = true;
      }
      // Parallel camera translation preserves back-to-front depth order.
      if (lastDirection.distanceToSquared(direction) < .003) return;
      lastDirection.copy(direction);
      for (let i = 0; i < count; i++) {
        sortDepth[i] = positions[i*3]*direction.x + positions[i*3+1]*direction.y + positions[i*3+2]*direction.z;
      }
      ids.sort((a,b) => sortDepth[b]-sortDepth[a]);
      order.needsUpdate = true;
    },
    release() {
      if (!resident) return;
      texture.dispose();
      geometry.dispose();
      resident = false;
    },
    dispose() { geometry.dispose(); material.dispose(); texture.dispose(); }
  };
}

function editedGaussians(edits,world,position,viewport,fog) {
  const data=[], centers=[], color=new THREE.Color();
  for (const [x,y,z,id] of edits.values()) {
    if (!id || Math.hypot(position.x-x,position.z-z)>157) continue;
    const tint=world.getTint(x,y,z);
    for (const [nx,ny,nz] of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]) {
      if (world.getBlock(x+nx,y+ny,z+nz)) continue;
      const tu=nx ? [0,0,1] : [1,0,0], tv=ny ? [0,0,1] : [0,1,0];
      const shade=.74+.35*Math.max(0,-.68*nx+.71*ny+.31*nz);
      color.setHex(tint).multiplyScalar(shade);
      for (const u of [-.34,0,.34]) for (const v of [-.34,0,.34]) {
        const px=x+.5+nx*.5+tu[0]*u+tv[0]*v;
        const py=y+.5+ny*.5+tu[1]*u+tv[1]*v;
        const pz=z+.5+nz*.5+tu[2]*u+tv[2]*v;
        centers.push(px,py,pz);
        data.push(px,py,pz,.98,tu[0]*.20,tu[1]*.20,tu[2]*.20,0,
          tv[0]*.20,tv[1]*.20,tv[2]*.20,.045,color.r,color.g,color.b,1);
      }
    }
  }
  return centers.length ? gaussianMesh(data,centers,viewport,fog) : null;
}

export class Game {
  constructor(canvas, callbacks = {}) {
    this.canvas = canvas;
    this.callbacks = callbacks;
    this.mobile = isMobileRenderer();
    this.videoField = new VideoField(this.mobile);
    this.budget = this.mobile?phoneBudget:desktopBudget;
    this.raster = new AdaptiveRaster();
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: !this.mobile, alpha: false, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = !this.mobile;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.needsUpdate = true;
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2('#d9dfd3', .0047);
    this.fov = 65;
    this.camera = new THREE.PerspectiveCamera(this.fov, 1, .07, 600);
    this.camera.rotation.order = 'YXZ';
    this.voxels = new THREE.Group();
    this.voxels.name = 'Editable voxel world';
    this.world = new VoxelWorld(this.voxels,this.budget);
    const projection=this.world.terrainProjection.uniforms;
    this.sky = createSky(projection);
    this.clouds = createClouds(projection);
    this.scene.add(this.sky, this.clouds, this.voxels);
    const ambient = new THREE.HemisphereLight('#e5eff8', '#ac9975', 1.25);
    this.sun = new THREE.DirectionalLight('#ffebcc', 2.28);
    this.sun.castShadow = !this.mobile;
    this.sun.shadow.mapSize.set(2048, 2048);
    const shadowCamera = this.sun.shadow.camera;
    Object.assign(shadowCamera, { left: -68, right: 68, top: 63, bottom: -63, near: 1, far: 234 });
    shadowCamera.updateProjectionMatrix();
    this.sun.shadow.bias = -.00018;
    this.sun.shadow.normalBias = .085;
    this.scene.add(ambient, this.sun, this.sun.target);
    const edgeBox = new THREE.BoxGeometry(1.009, 1.009, 1.009);
    this.outline = new THREE.LineSegments(
      new THREE.EdgesGeometry(edgeBox), new THREE.LineBasicMaterial({ color: '#fff1bc', transparent: true, opacity: .87 })
    );
    edgeBox.dispose();
    this.outline.visible = false;
    this.scene.add(this.outline);
    this.fragments = new THREE.InstancedMesh(new THREE.BoxGeometry(1,1,1),new THREE.MeshLambertMaterial(),48);
    this.fragments.count = 0;
    this.fragments.frustumCulled = false;
    this.particles = [];
    this.particleMatrix = new THREE.Matrix4();
    this.scene.add(this.fragments);
    this.position = new THREE.Vector3(0, 8, 0);
    this.viewport = new THREE.Vector2(1, 1);
    this.forward = new THREE.Vector3(0, 0, -1);
    this.skyTop = new THREE.Color();
    this.skyHorizon = new THREE.Color();
    this.lastLight = new THREE.Vector2(Infinity, Infinity);
    this.keys = new Set();
    this.keyOwners = new Map();
    this.regions = [];
    this.stamps=[];
    this.viewAtlas=new ViewVolumeAtlas(this.budget,this.world.terrainProjection.uniforms);
    this.scene.add(this.viewAtlas.mesh);
    this.viewAtlas.mesh.visible=false;
    this.stampClip=new StampClip();
    this.liveViews=false;
    this.placingView=false;
    this.liveLens=null;
    this.liveOffsets=null;
    this.recalledAspect=null;
    this.passages = [];
    this.guidedEdge = null;
    this.morphState = null;
    this.liveField = null;
    this.morphEdits=new MorphEditVolume();
    this.photoSlopes = null;
    this.localRegions = [];
    this.photoResidents = new Set();
    this.areaCenter = new THREE.Vector2(Infinity, Infinity);
    this.edits = new Map();
    this.editSnapshot = null;
    this.editField = null;
    this.editFieldCenter = new THREE.Vector2(Infinity,Infinity);
    this.editFieldDirty = false;
    this.queue = Promise.resolve();
    this.mode = 'hybrid';
    this.splats = .65;
    this.yaw = 0;
    this.pitch = 0;
    this.slot = 0;
    this.velocityY = 0;
    this.grounded = false;
    this.flying = false;
    this.playing = false;
    this.suspended = false;
    this.drawRequested = true;
    this.lastDraw = 0;
    this.locked = false;
    this.lastSpace = -Infinity;
    this.statsTime = 0;
    this.fps = 60;
    this.activeRegion = 0;
    this.drawSize = [0, 0, 0];
    this.lastMeshCount = -1;
    this.disposeEvents = new AbortController();
    this.bindControls();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.resize();
    this.frame = this.frame.bind(this);
    this.lastFrame = performance.now();
    this.frameId = requestAnimationFrame(this.frame);
  }

  notify(name, ...args) { this.callbacks[name]?.(...args); }

  resize() {
    const width = Math.max(1, this.canvas.clientWidth || 1);
    const height = Math.max(1, this.canvas.clientHeight || 1);
    const scale = Math.min(window.devicePixelRatio || 1, this.budget.pixelRatio, Math.sqrt(this.budget.rasterPixels / (width*height)))*this.raster.scale;
    if (this.drawSize[0] === width && this.drawSize[1] === height && this.drawSize[2] === scale) return;
    if((this.drawSize[0]>this.drawSize[1])!==(width>height)){
      this.drag=null;this.heldAction=null;
    }
    this.drawSize = [width, height, scale];
    this.drawRequested = true;
    this.renderer.setDrawingBufferSize(width,height,scale);
    this.renderer.getDrawingBufferSize(this.viewport);
    this.updateViewport();
    this.updateLens();
  }

  bindControls() {
    const listen = (target, name, callback, options = {}) =>
      target.addEventListener(name, callback, { ...options, signal: this.disposeEvents.signal });
    const editable = target => target?.closest?.('input,textarea,select,[contenteditable=true]');
    listen(window, 'keydown', event => {
      if (!this.playing || editable(event.target) || event.metaKey || event.altKey) return;
      if (controls.has(event.code)) {
        event.preventDefault();
        if (!event.repeat) this.moveKey(event.code, true);
      } else if (/^(Digit|Numpad)[1-7]$/.test(event.code)) {
        event.preventDefault();
        this.select(Number(event.code.slice(-1))-1);
      } else if (event.code === 'KeyF' && !event.repeat) {
        event.preventDefault();
        this.toggleFlight();
      } else if (event.code === 'KeyE' || event.code === 'KeyR') {
        event.preventDefault();
        if (!event.repeat) this.interact(event.code === 'KeyR');
      } else if (event.code === 'Escape') {
        this.pause();
      }
    });
    listen(window, 'keyup', event => {
      if (controls.has(event.code)) this.moveKey(event.code, false);
    });
    listen(window, 'blur', () => this.pause());
    listen(window, 'pagehide', () => { this.pause(); this.videoField.setSuspended(true); });
    listen(window, 'pageshow', () => this.videoField.setSuspended(this.suspended || document.hidden));
    listen(document, 'visibilitychange', () => {
      if (document.hidden) this.pause();
      this.videoField.setSuspended(this.suspended || document.hidden);
    });
    listen(document, 'pointerlockchange', () => {
      const locked = document.pointerLockElement === this.canvas;
      if (locked && !this.playing) {
        document.exitPointerLock?.();
        return;
      }
      if (this.locked && !locked) this.pause();
      this.locked = locked;
    });
    listen(document, 'mousemove', event => {
      if (this.playing && document.pointerLockElement === this.canvas) this.look(event.movementX, event.movementY);
    });
    listen(this.canvas, 'pointerdown', event => {
      if (!this.regions.length || event.button < 0 || event.button > 2) return;
      if (!this.playing) {
        this.play();
        return;
      }
      if (event.button === 1) {
        const hit = this.target();
        const slot = hit && BLOCKS.findIndex(b=>b.id===hit.id);
        if (hit && slot>=0) this.select(slot);
        event.preventDefault();
        return;
      }
      if (document.pointerLockElement === this.canvas) {
        this.interact(event.button === 2);
        this.heldAction = { id:event.pointerId, place: event.button === 2, next: performance.now() + 360 };
      } else {
        if (this.drag && this.drag.id !== event.pointerId) return;
        this.drag = { id: event.pointerId, x: event.clientX, y: event.clientY, travel: 0, button: event.button };
        try { this.canvas.setPointerCapture?.(event.pointerId); } catch { /* The next window release still ends the drag. */ }
      }
      event.preventDefault();
    });
    listen(this.canvas, 'pointermove', event => {
      if (!this.playing || this.drag?.id !== event.pointerId || document.pointerLockElement === this.canvas) return;
      const dx = event.clientX - this.drag.x, dy = event.clientY - this.drag.y;
      this.drag.travel += Math.hypot(dx, dy);
      this.drag.x = event.clientX;
      this.drag.y = event.clientY;
      this.look(dx, dy);
    });
    listen(window, 'pointerup', event => {
      if (this.heldAction?.id === event.pointerId) this.heldAction = null;
      if (this.drag?.id !== event.pointerId) return;
      if (this.playing && this.drag.travel < 5) this.interact(this.drag.button === 2);
      this.drag = null;
    });
    const cancelPointer = event => {
      if (this.heldAction?.id === event.pointerId) this.heldAction = null;
      if (this.drag?.id === event.pointerId) this.drag = null;
    };
    listen(window, 'pointercancel', cancelPointer, {capture:true});
    listen(this.canvas, 'lostpointercapture', cancelPointer);
    listen(this.canvas, 'contextmenu', event => event.preventDefault());
    listen(this.canvas, 'wheel', event => {
      if (!this.playing) return;
      event.preventDefault();
      if (!event.deltaY) return;
      const now = performance.now();
      if (now < (this.nextWheel || 0)) return;
      this.nextWheel = now + 95;
      this.select((this.slot + Math.sign(event.deltaY) + BLOCKS.length) % BLOCKS.length);
    }, { passive: false });
  }

  updateViewport() {
    const [width,height]=this.drawSize;
    const aspect=this.recalledAspect || width/height;
    // Explicitly recalling an old view on a different screen preserves both
    // axes of its capture with a centered viewport.
    const w=Math.min(width,height*aspect),h=Math.min(height,width/aspect);
    this.renderer.setViewport((width-w)/2,(height-h)/2,w,h);
    this.camera.aspect=aspect;
  }

  useLiveViewport() {
    if(this.recalledAspect===null)return;
    this.recalledAspect=null;
    this.updateViewport();this.updateLens();
  }

  captureView() {
    this.updateCamera();
    const frame=captureStamp(this.camera);
    return Object.freeze({...frame,eye:Object.freeze({x:this.camera.position.x,y:this.camera.position.y,z:this.camera.position.z}),
      x:this.camera.position.x,y:this.camera.position.y,z:this.camera.position.z,
      yaw:this.yaw,pitch:this.pitch,flying:this.flying,fov:this.camera.fov,aspect:this.camera.aspect,near:this.camera.near,far:this.camera.far});
  }

  turnView(deltaYaw,deltaPitch=0) {
    if(!Number.isFinite(deltaYaw)||!Number.isFinite(deltaPitch))return;
    this.useLiveViewport();
    this.yaw=(this.yaw+deltaYaw)%(2*Math.PI);
    this.pitch=clamp(this.pitch+deltaPitch,-Math.PI*.5+.009,Math.PI*.5-.009);
    this.guidedEdge=null;
    this.updateCamera();this.updateAtmosphere(0);this.drawRequested=true;this.emitStats();
  }

  addViewPhoto(profile,capture=this.captureView(),options={}) {
    // Snapshot before image processing or any queued work can yield. A
    // player can look elsewhere while the detector and depth model run.
    const normalized=cameraStamp(capture);
    const eye=Object.freeze({x:normalized.x,y:normalized.y,z:normalized.z});
    const frame=Object.freeze({...normalized,eye});
    if(![eye.x,eye.y,eye.z,frame.fov,frame.aspect,frame.near,frame.far].every(Number.isFinite)
      ||frame.slopeX<=0||frame.slopeY<=0||frame.near<=0||frame.far<=frame.near)
      return Promise.reject(new Error('The photograph needs a valid camera view.'));
    if(this.restoringViews){
      const id=this.restoringViews.length;
      this.restoringViews.push({profile,frame,id,options});
      return Promise.resolve(id);
    }
    const run=this.queue.then(async()=>{
      const index=this.stamps.length;
      await this.viewAtlas.add(profile,frame,index,options);
      const bounds=this.viewAtlas.lastBounds;
      this.registerPhoto(profile,frame,bounds);
      await this.finishPhotoChanges(bounds);
      return index;
    });
    this.queue=run.catch(()=>{});
    return run;
  }

  registerPhoto(profile,frame,bounds){
    this.viewAtlas.preferredCapture=this.stamps.length;
    this.stamps.push({profile,capture:frame,bounds});
    if(!this.liveViews) {
      this.liveLens=this.camera.fov;
      this.liveViews=true;this.guidedEdge=null;this.photoSlopes=null;
      if(this.liveField)this.liveField.mesh.visible=false;
      this.stampClip.apply(this.world.trimMaterial);
      for(const r of this.regions){
        this.stampClip.apply(r.field.mesh.material);
        this.stampClip.apply(r.surface.mesh.children[0].material);
      }
    }
    this.world.registerView(this.viewAtlas,bounds);
    this.stampClip.add(frame);
  }

  async finishPhotoChanges(bounds){
    for(const [x,y,z] of this.edits.values())this.viewAtlas.maskCell(x,y,z);
    this.placingView=true;
    try{await this.world.refreshView(bounds);}
    finally{this.placingView=false;}
    this.viewAtlas.mesh.visible=this.liveViews;
    this.drawRequested=true;this.renderer.shadowMap.needsUpdate=true;
    this.updateAtmosphere(0);this.emitStats();
  }

  beginViewRestore(){
    if(!this.stamps.length)this.restoringViews=[];
  }

  async finishViewRestore(){
    const entries=this.restoringViews;
    this.restoringViews=null;
    if(!entries?.length)return;
    const last=entries.at(-1);
    // Keep the final insertion on the ordinary path if it needs the
    // previous geometry for a replay or live placement animation.
    const replay=last.options.animate!==false||last.options.prepareReplay;
    const initial=replay?entries.slice(0,-1):entries;
    if(initial.length){
      await this.viewAtlas.restore(initial);
      const bounds={...this.viewAtlas.stamps[0].bounds};
      for(const {id,profile,frame} of initial){
        const extent=this.viewAtlas.stamps[id].bounds;
        this.registerPhoto(profile,frame,extent);
        for(const side of ['minX','minY','minZ'])bounds[side]=Math.min(bounds[side],extent[side]);
        for(const side of ['maxX','maxY','maxZ'])bounds[side]=Math.max(bounds[side],extent[side]);
      }
      await this.finishPhotoChanges(bounds);
    }
    if(replay)await this.addViewPhoto(last.profile,last.frame,last.options);
  }

  get canReplayPlacement() {return this.liveViews&&this.viewAtlas.canReplayPlacement;}
  replayPlacement() {
    if(!this.canReplayPlacement || this.placingView || !this.viewAtlas.replayLastPlacement())return false;
    this.drawRequested=true;this.emitStats();return true;
  }

  goToStamp(index) {
    const stamp=this.stamps[index];
    if(!stamp)return false;
    const f=stamp.capture,eye=f.eye;
    this.viewAtlas.preferredCapture=index;
    if(typeof f.flying==='boolean')this.flying=f.flying;
    this.position.set(eye.x,eye.y-eyeHeight,eye.z);this.yaw=f.yaw;this.pitch=f.pitch;
    this.liveLens=f.fov;this.recalledAspect=f.aspect;
    this.camera.near=f.near;this.camera.far=f.far;
    this.liveOffsets=[f.offsetX||0,f.offsetY||0];
    this.guidedEdge=null;this.velocityY=0;this.grounded=false;this.clearKeys();
    this.updateViewport();this.updateCamera();this.updateAtmosphere(1);
    this.drawRequested=true;this.emitStats();return true;
  }

  nextAnchor() {
    if (!this.regions.length) return { ...north };
    const dx = Math.sin(this.yaw), dz = -Math.cos(this.yaw);
    const anchor = { x: this.position.x + dx*24, z: this.position.z + dz*24, dx, dz };
    // Only the fringe of the new footprint can overlay an earlier photo's
    // central landmarks. Repeated uploads from a fixed position extend ahead.
    for (let pass = 0; pass < this.regions.length; pass++) {
      let shift = 0;
      for (const region of this.regions) shift = Math.max(shift,clearance(anchor,region.anchor));
      if (!shift) break;
      anchor.x += shift*dx;
      anchor.z += shift*dz;
    }
    return anchor;
  }

  addRegion(profile, anchorOverride) {
    const run = this.queue.then(async () => {
      const anchor = anchorOverride ? { ...anchorOverride } : this.nextAnchor();
      const len = Math.hypot(anchor.dx, anchor.dz) || 1;
      anchor.dx /= len;
      anchor.dz /= len;
      const starter = this.regions.length === 0;
      await this.world.addRegion(profile, anchor);
      let passage=null;
      if(!starter){
        const fallback=anchorOverride?this.regions.length-1:this.activeRegion;
        const requested=anchor.from??fallback;
        anchor.from=Number.isInteger(requested)&&this.regions[requested]?requested:this.regions.length-1;
        passage=this.world.addPassage(this.regions[anchor.from].anchor,anchor);
      }
      const sky = skyColors(profile, starter);
      const surface=await createPhotoSurface(profile,anchor,this.world.getGround(anchor.x,anchor.z)+eyeHeight,this.world,false);
      const field = makeSplatField(this.world, profile, anchor, starter, this.viewport, this.scene.fog.color,this.mobile);
      for (const [x,y,z] of this.edits.values()) {field.maskCell(x,y,z);surface.maskCell(x,y,z);}
      this.scene.add(field.mesh,surface.mesh);
      if(this.liveViews){
        this.stampClip.apply(field.mesh.material);
        this.stampClip.apply(surface.mesh.children[0].material);
      }
      const to=this.regions.length;
      this.regions.push({ anchor, sky, field, profile, surface });
      if(passage)this.passages[to]={...passage,from:anchor.from,to,guides:Array.isArray(anchor.guides)?anchor.guides:[]};
      this.areaCenter.set(Infinity, Infinity);
      this.renderer.shadowMap.needsUpdate = true;
      if (starter) {
        this.goTo(0);
        this.sky.material.uniforms.topColor.value.copy(sky.top);
        this.sky.material.uniforms.horizonColor.value.copy(sky.horizon);
      } else if (this.collides(this.position.x, this.position.y, this.position.z)) {
        this.position.y = Math.max(this.position.y, this.world.getGround(this.position.x,this.position.z));
      }
      this.updateCamera();
      this.updateAtmosphere(1);
      if(surface.resident)await surface.ready;
      this.emitStats();
      return { ...anchor };
    });
    this.queue = run.catch(() => {});
    return run;
  }

  play() {
    if (this.playing || this.suspended || !this.regions.length) return;
    this.playing = true;
    this.canvas.focus?.({ preventScroll: true });
    this.notify('onPlay', true);
    if (document.documentElement.dataset.platform!=='phone' && !window.matchMedia('(pointer: coarse)').matches && this.canvas.requestPointerLock) {
      // Embedded viewers can deny pointer lock. Drag-to-look uses the same
      // camera path and remains available in that case.
      try { this.canvas.requestPointerLock()?.catch?.(() => {}); } catch {}
    }
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    this.clearKeys();
    this.drag = this.heldAction = null;
    this.locked = false;
    this.outline.visible = false;
    if (document.pointerLockElement === this.canvas) document.exitPointerLock?.();
    this.notify('onPlay', false);
    this.emitStats();
  }

  setSuspended(suspended) {
    if (this.suspended === !!suspended) return;
    this.suspended = !!suspended;
    this.videoField.setSuspended(this.suspended || document.hidden);
    if (this.suspended) {
      this.pause();
      cancelAnimationFrame(this.frameId);
      return;
    }
    this.lastFrame = performance.now();
    this.drawRequested = true;
    this.renderer.shadowMap.needsUpdate = true;
    this.updateCamera();
    this.frameId = requestAnimationFrame(this.frame);
  }

  select(index) {
    if (!Number.isFinite(index)) return;
    this.slot = clamp(Math.round(index), 0, BLOCKS.length-1);
    this.notify('onSelect', this.slot);
  }

  setMode(mode) {
    if (!['hybrid', 'voxel', 'splat'].includes(mode)) return;
    this.mode = mode;
    this.drawRequested = true;
    this.voxels.visible = mode !== 'splat';
    this.updateAtmosphere(0);
  }

  setSplats(value) {
    if (Number.isFinite(value)) this.splats = clamp(value, 0, 1);
    this.drawRequested = true;
    this.updateAtmosphere(0);
  }

  setFov(degrees) {
    if (!Number.isFinite(degrees)) return;
    this.fov = clamp(degrees, 35, 110);
    if(this.liveViews || this.liveLens!==null){
      this.liveLens=this.fov;this.recalledAspect=null;this.liveOffsets=null;this.updateViewport();
    }
    this.updateLens();
    this.drawRequested = true;
  }

  updateLens() {
    if(this.liveLens!==null){
      this.camera.fov=this.liveLens;
      this.camera.updateProjectionMatrix();
      if(this.liveOffsets?.some(Boolean)){
        const projection=this.camera.projectionMatrix;
        projection.elements[8]=this.liveOffsets[0]*projection.elements[0];
        projection.elements[9]=this.liveOffsets[1]*projection.elements[5];
        this.camera.projectionMatrixInverse.copy(projection).invert();
      }
      return;
    }
    // Preserve a 60-degree horizontal view at the default lens on narrow
    // canvas layouts while keeping the requested vertical lens on wide views.
    const tangent = Math.tan(this.fov*radians*.5);
    const portrait = 2*Math.atan(tangent*.9063/this.camera.aspect)/radians;
    let lens=Math.max(this.fov,Math.min(105,portrait));
    if(this.photoSlopes){
      const {x,y,weight}=this.photoSlopes;
      const aperture=.5*Math.min(y,x/this.camera.aspect);
      const calibrated=2*Math.atan(aperture)/radians;
      const fit=2*Math.atan(aperture*tangent/Math.tan(65*radians*.5))/radians;
      lens=THREE.MathUtils.lerp(lens,clamp(fit,Math.min(12,calibrated),150),weight);
    }
    this.camera.fov=lens;
    this.camera.updateProjectionMatrix();
  }

  toggleFlight() {
    this.flying = !this.flying;
    this.velocityY = 0;
    if (this.flying && this.grounded) this.position.y += .16;
    this.grounded = false;
    this.notify('onNotice', this.flying ? 'Flight enabled' : 'Flight disabled');
    this.emitStats();
    return this.flying;
  }

  routeYaw(edge,t) {
    const a=this.regions[edge.from].anchor,b=this.regions[edge.to].anchor;
    const start=Math.atan2(a.dx,-a.dz),end=Math.atan2(b.dx,-b.dz);
    return start+Math.atan2(Math.sin(end-start),Math.cos(end-start))*t;
  }

  setMorphGuides(toIndex,pairs) {
    const edge=this.passages[toIndex];
    if(!edge || !Array.isArray(pairs))return false;
    const guides=pairs.filter(p=>p && [p.x,p.y,p.tx,p.ty].every(Number.isFinite))
      .map(p=>({x:clamp(p.x,0,1),y:clamp(p.y,0,1),tx:clamp(p.tx,0,1),ty:clamp(p.ty,0,1)}));
    edge.guides=guides;edge.flow=null;this.regions[toIndex].anchor.guides=guides;
    if(this.liveField?.edge===edge){this.scene.remove(this.liveField.mesh);this.liveField.dispose();this.liveField=null;}
    this.drawRequested=true;this.updateAtmosphere(1);this.emitStats();return true;
  }

  frameMorph(toIndex,fraction=0) {
    if(this.liveViews)return false;
    const edge=this.passages[toIndex];
    if(!edge || !Number.isFinite(fraction))return false;
    const t=clamp(fraction,0,1),d=t*edge.length;
    this.guidedEdge=edge;
    const x=edge.x+edge.dx*d,z=edge.z+edge.dz*d;
    this.position.set(x,this.world.getGround(x,z)+.015,z);
    for(let i=0;i<80 && this.collides(x,this.position.y,z);i++)this.position.y+=1;
    this.velocityY=0;this.grounded=!this.flying;
    this.yaw=this.routeYaw(edge,t);this.pitch=0;
    this.drawRequested=true;
    this.updateCamera();this.updateAtmosphere(1);this.emitStats();
    return true;
  }

  findPassage() {
    const p=this.position;
    let edge=null,best=Infinity,state=null;
    for(const candidate of this.passages){
      if(!candidate || (this.guidedEdge && candidate!==this.guidedEdge))continue;
      const ox=p.x-candidate.x,oz=p.z-candidate.z;
      const along=ox*candidate.dx+oz*candidate.dz;
      const distance=clamp(along,0,candidate.length),t=distance/candidate.length;
      const across=Math.hypot(ox-distance*candidate.dx,oz-distance*candidate.dz);
      if(across>13 || along < -.55 || along>candidate.length+.55)continue;
      const score=across+.01*Math.min(t,1-t);
      if(score>=best)continue;
      edge=candidate;best=score;
      state={from:edge.from,to:edge.to,t,distance,length:edge.length,across,weight:1-smooth(across,2.5,13)};
    }
    if(!state)this.guidedEdge=null;
    return state;
  }

  updatePhotoViews(state){
    const p=this.position;
    // A route can need both endpoint photos even when neither static mesh
    // is visible. Pin that pair, then keep the strongest neighboring region.
    const wanted=new Set(state ? [state.from,state.to] : [this.activeRegion]);
    const ranked=this.localRegions.slice().sort((a,b)=>this.regions[b].atmosphereWeight-this.regions[a].atmosphereWeight);
    for(const index of ranked){
      if(wanted.size>=3)break;
      wanted.add(index);
    }
    for(const index of this.photoResidents)if(!wanted.has(index)){
      const region=this.regions[index];
      region.surface.release(); region.field.release();
    }
    for(const index of wanted){
      const source=this.regions[index].surface;
      if(!source.resident)source.retain().then(()=>{this.drawRequested=true;});
    }
    this.photoResidents=wanted;
    if(state){
      const edge=this.passages[state.to],a=this.regions[state.from],b=this.regions[state.to];
      const t=state.t, x=edge.x+edge.dx*state.distance,z=edge.z+edge.dz*state.distance;
      const eye=this.world.getGround(x,z)+eyeHeight;
      const displacement=Math.hypot(state.across,p.y+eyeHeight-eye);
      if(!this.liveField || this.liveField.edge!==edge){
        if(this.liveField){this.scene.remove(this.liveField.mesh);this.liveField.dispose();}
        edge.flow??=correspondence(a.profile,b.profile,33,25,edge.guides);
        this.liveField=createMorphField(a,b,edge.flow,this.morphEdits);this.liveField.edge=edge;this.scene.add(this.liveField.mesh);
      }
      this.liveField.update(t,state.weight,this.mode,this.splats,displacement);
      this.liveField.mesh.position.y=eye;
      this.activeRegion=t<.5?state.from:state.to;
      this.photoSlopes={x:THREE.MathUtils.lerp(a.surface.frame.slopeX,b.surface.frame.slopeX,t),
        y:THREE.MathUtils.lerp(a.surface.frame.slopeY,b.surface.frame.slopeY,t),weight:state.weight};
    }else{
      if(this.liveField)this.liveField.mesh.visible=false;
      const a=this.regions[this.activeRegion];
      const dist=Math.hypot(p.x-a.anchor.x,p.y+eyeHeight-a.surface.frame.eyeY,p.z-a.anchor.z);
      this.photoSlopes={x:a.surface.frame.slopeX,y:a.surface.frame.slopeY,weight:1-smooth(dist,.4,8)};
    }
    this.updateLens();
    for(const i of this.localRegions){
      const r=this.regions[i],dist=Math.hypot(p.x-r.anchor.x,p.y+eyeHeight-r.surface.frame.eyeY,p.z-r.anchor.z);
      if(!wanted.has(i)){
        r.field.mesh.visible=false;
        continue;
      }
      const dominant=this.regions[this.activeRegion].atmosphereWeight || 1;
      const local=smooth(r.atmosphereWeight/dominant,.016,.8)*(1-smooth(dist,85,165));
      const keep=state?1-state.weight:1;
      r.surface.setAppearance(this.mode,this.splats,local*keep,dist);
      if(r.field.mesh.visible){
        const original=this.mode==='hybrid'?smooth(dist,1.2,11):1;
        r.field.mesh.material.uniforms.visibility.value*=keep*original;
        if(keep*original<.005)r.field.mesh.visible=false;
        if(r.field.mesh.visible)r.field.sort(this.forward);
      }
    }
  }

  goTo(index) {
    const region = this.regions[index];
    if (!region) return;
    this.guidedEdge=null;
    const a = region.anchor;
    this.position.set(a.x, this.world.getGround(a.x, a.z) + .015, a.z);
    // The stock world leaves entry points free. Also accommodate a player
    // construction that may cover a previously saved entry.
    for (let i = 0; i < 72 && this.collides(this.position.x, this.position.y, this.position.z); i++) this.position.y += 1;
    this.yaw = Math.atan2(a.dx, -a.dz);
    this.pitch = 0;
    this.velocityY = 0;
    this.grounded = false;
    this.activeRegion = index;
    this.drawRequested = true;
    this.clearKeys();
    this.renderer.shadowMap.needsUpdate = true;
    this.updateCamera();
    this.updateAtmosphere(1);
    this.emitStats();
  }

  clearKeys() {
    this.keys.clear();
    this.keyOwners.clear();
  }

  moveKey(code, pressed, owner='keyboard') {
    let owners = this.keyOwners.get(code);
    if (!pressed) {
      if (!owners?.delete(owner) || owners.size) return;
      this.keyOwners.delete(code);
      this.keys.delete(code);
      return;
    }
    if (!this.playing) return;
    if (owners) { owners.add(owner); return; }
    this.keyOwners.set(code, new Set([owner]));
    this.useLiveViewport();
    this.keys.add(code);
    if (code !== 'Space') return;
    const now = performance.now();
    if (now - this.lastSpace < 265) {
      this.toggleFlight();
      this.lastSpace = -Infinity;
    } else {
      this.lastSpace = now;
      if (!this.flying && this.grounded) {
        this.velocityY = 8.15;
        this.grounded = false;
      }
    }
  }

  look(dx, dy) {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    if(dx || dy)this.useLiveViewport();
    this.yaw = (this.yaw + dx*.00215) % (2*Math.PI);
    this.pitch = clamp(this.pitch - dy*.00215, -Math.PI/2+.009, Math.PI/2-.009);
    this.updateCamera();
  }

  updateCamera() {
    this.camera.position.set(this.position.x, this.position.y+eyeHeight, this.position.z);
    this.camera.rotation.set(this.pitch, -this.yaw, 0, 'YXZ');
    this.camera.getWorldDirection(this.forward);
    this.sky.position.copy(this.camera.position);
    this.clouds.position.set(this.position.x*.91, 0, this.position.z*.91);
    const lx = Math.round((this.position.x+this.forward.x*27)/5)*5;
    const lz = Math.round((this.position.z+this.forward.z*27)/5)*5;
    if (lx !== this.lastLight.x || lz !== this.lastLight.y) {
      this.lastLight.set(lx,lz);
      this.sun.target.position.set(lx, 3, lz);
      this.sun.position.set(lx-68, 71, lz+31);
      this.renderer.shadowMap.needsUpdate = true;
    }
  }

  collides(x, y, z) {
    const minX = Math.floor(x-bodyRadius+epsilon), maxX = Math.floor(x+bodyRadius-epsilon);
    const minY = Math.floor(y+epsilon), maxY = Math.floor(y+bodyHeight-epsilon);
    const minZ = Math.floor(z-bodyRadius+epsilon), maxZ = Math.floor(z+bodyRadius-epsilon);
    for (let by = minY; by <= maxY; by++) {
      for (let bz = minZ; bz <= maxZ; bz++) {
        for (let bx = minX; bx <= maxX; bx++) if (this.world.getBlock(bx,by,bz)) return true;
      }
    }
    return false;
  }

  moveHorizontal(axis, amount) {
    if (!amount) return;
    const p = this.position;
    const x = p.x + (axis === 'x' ? amount : 0), z = p.z + (axis === 'z' ? amount : 0);
    if (!this.collides(x,p.y,z)) { p[axis] += amount; return; }
    const top = Math.floor(p.y+0.001) + 1;
    if (this.grounded && !this.flying && top-p.y <= 1.001 &&
        !this.collides(p.x,top,p.z) && !this.collides(x,top,z)) {
      p[axis] += amount;
      p.y = top;
    }
  }

  moveVertical(amount) {
    if (!amount) return;
    const p = this.position;
    if (!this.collides(p.x,p.y+amount,p.z)) { p.y += amount; return; }
    let safe = 0, blocked = 1;
    for (let i = 0; i < 9; i++) {
      const mid = (safe+blocked)*.5;
      if (this.collides(p.x,p.y+amount*mid,p.z)) blocked = mid;
      else safe = mid;
    }
    p.y += amount*safe;
    this.velocityY = 0;
    if (amount < 0) this.grounded = true;
  }

  simulate(dt) {
    const k = this.keys;
    const turn = Number(k.has('KeyL')) - Number(k.has('KeyJ'));
    const tilt = Number(k.has('KeyI')) - Number(k.has('KeyK'));
    this.yaw = (this.yaw + turn*dt*1.7) % (Math.PI*2);
    this.pitch = clamp(this.pitch + tilt*dt*1.35, -Math.PI/2+.009, Math.PI/2-.009);
    const front = Number(k.has('KeyW') || k.has('ArrowUp')) - Number(k.has('KeyS') || k.has('ArrowDown'));
    const side = Number(k.has('KeyD') || k.has('ArrowRight')) - Number(k.has('KeyA') || k.has('ArrowLeft'));
    const sprint = k.has('ShiftLeft') || k.has('ShiftRight');
    const speed = (this.flying ? (sprint ? 18 : 10) : (sprint ? 7.3 : 4.65)) / (Math.hypot(side,front) || 1);
    const edge=this.guidedEdge;
    const t0=edge?clamp(((this.position.x-edge.x)*edge.dx+(this.position.z-edge.z)*edge.dz)/edge.length,0,1):0;
    let dx=(Math.sin(this.yaw)*front+Math.cos(this.yaw)*side)*speed*dt;
    let dz=(-Math.cos(this.yaw)*front+Math.sin(this.yaw)*side)*speed*dt;
    if(edge){
      // W/S advance along the passage even when its photo cameras face in
      // different directions. Mouse look, jump and strafe remain independent.
      const stride=front*speed*(this.flying?1:1.75)*dt,slide=side*speed*dt;
      dx=edge.dx*stride-edge.dz*slide;
      dz=edge.dz*stride+edge.dx*slide;
    }
    if (this.flying) {
      const down = k.has('KeyQ') || k.has('KeyC') || k.has('ControlLeft') || k.has('ControlRight');
      this.velocityY = (Number(k.has('Space'))-Number(down)) * (sprint ? 15 : 7.5);
    } else {
      this.velocityY = Math.max(-34, this.velocityY - 22.5*dt);
    }
    const dy = this.velocityY*dt;
    const steps = Math.max(1,Math.ceil(Math.max(Math.abs(dx),Math.abs(dz),Math.abs(dy))/.22));
    for (let i = 0; i < steps; i++) {
      this.moveHorizontal('x',dx/steps);
      this.moveHorizontal('z',dz/steps);
      this.moveVertical(dy/steps);
    }
    if(edge){
      const ox=this.position.x-edge.x,oz=this.position.z-edge.z;
      const along=ox*edge.dx+oz*edge.dz,t1=clamp(along/edge.length,0,1);
      this.yaw+=this.routeYaw(edge,t1)-this.routeYaw(edge,t0);
      if(Math.abs(ox*edge.dz-oz*edge.dx)>3.5 || along<-.5 || along>edge.length+.5)this.guidedEdge=null;
    }
    this.grounded = !this.flying && this.collides(this.position.x,this.position.y-.026,this.position.z);
    if (this.world.belowWorld(this.position.x,this.position.y,this.position.z)) this.goTo(this.activeRegion);
  }

  target() {
    const p = this.camera.position, d = this.forward;
    return traceVoxels(this.world,p.x,p.y,p.z,d.x,d.y,d.z,7);
  }

  interact(place) {
    if (!this.regions.length) return false;
    const hit = this.target();
    if (!hit) return false;
    let { x, y, z } = hit;
    const id = place ? BLOCKS[this.slot].id : 0;
    if (place) {
      x += hit.nx; y += hit.ny; z += hit.nz;
      const p = this.position;
      if (this.world.getBlock(x,y,z) || (x+1 > p.x-bodyRadius+epsilon && x < p.x+bodyRadius-epsilon &&
          y+1 > p.y+epsilon && y < p.y+bodyHeight-epsilon &&
          z+1 > p.z-bodyRadius+epsilon && z < p.z+bodyRadius-epsilon)) return false;
    }
    const tint = place ? 0 : this.world.getTint(x,y,z);
    if (this.world.setBlock(x,y,z,id) === false) return false;
    if (!place) this.breakFragments(x,y,z,tint);
    this.edits.set([x,y,z].join(','),Object.freeze([x,y,z,id]));
    this.morphEdits.mark(x,y,z);
    if(this.stamps.length)this.viewAtlas.maskCell(x,y,z);
    this.editSnapshot = null;
    this.editFieldDirty = true;
    for (const i of this.localRegions) {this.regions[i].field.maskCell(x,y,z);this.regions[i].surface.maskCell(x,y,z);}
    this.renderer.shadowMap.needsUpdate = true;
    this.notify('onEdit');
    this.emitStats();
    return true;
  }

  breakFragments(x,y,z,color) {
    const random = randomStream((x*73856093)^(y*19349663)^(z*83492791));
    for (let i=0; i<9; i++) {
      if (this.particles.length>=48) this.particles.shift();
      const vx = (random()-.5)*3.1, vz = (random()-.5)*3.1;
      const tint = new THREE.Color(color).multiplyScalar(.83+random()*.28);
      this.particles.push({ x:x+.5+vx*.16,y:y+.54+random()*.4,z:z+.5+vz*.16,
        vx,vy:1.8+random()*2.5,vz,size:.06+random()*.09,life:.38+random()*.25,tint });
    }
  }

  updateFragments(dt) {
    if (!this.particles.length && !this.fragments.count) return;
    this.particles = this.particles.filter(p=>p.life>0);
    this.fragments.count = this.particles.length;
    this.particles.forEach((p,i)=>{
      p.life-=dt; p.vy-=dt*12;
      p.x+=p.vx*dt; p.y+=p.vy*dt; p.z+=p.vz*dt;
      const s=p.size*smooth(p.life,0,.17);
      this.particleMatrix.makeScale(s,s,s).setPosition(p.x,p.y,p.z);
      this.fragments.setMatrixAt(i,this.particleMatrix);
      this.fragments.setColorAt(i,p.tint);
    });
    this.fragments.instanceMatrix.needsUpdate=true;
    if (this.fragments.instanceColor) this.fragments.instanceColor.needsUpdate=true;
  }

  updateAtmosphere(dt,viewDt=0) {
    if (!this.regions.length) return;
    this.skyTop.setRGB(0,0,0);
    this.skyHorizon.setRGB(0,0,0);
    const p = this.position;
    if (this.mode === 'splat' && this.edits.size &&
        (this.editFieldDirty || Math.hypot(p.x-this.editFieldCenter.x,p.z-this.editFieldCenter.y)>36)) {
      if (this.editField) { this.scene.remove(this.editField.mesh); this.editField.dispose(); }
      this.editField = editedGaussians(this.edits,this.world,p,this.viewport,this.scene.fog.color);
      if (this.editField) {
        this.editField.mesh.renderOrder=1100;
        this.editField.mesh.material.uniforms.hybrid.value=0;
        this.scene.add(this.editField.mesh);
      }
      this.editFieldCenter.set(p.x,p.z);
      this.editFieldDirty=false;
    }
    if (this.editField) {
      this.editField.mesh.visible=this.mode==='splat' && this.splats>0;
      if (this.editField.mesh.visible) {
        this.editField.mesh.material.uniforms.intensity.value=Math.min(1,this.splats*1.45);
        this.editField.sort(this.forward);
      }
    }
    if (Math.abs(this.areaCenter.x-p.x)>6 || Math.abs(this.areaCenter.y-p.z)>6) {
      this.areaCenter.set(p.x,p.z);
      this.localRegions.length = 0;
      let nearest = 0, closest = Infinity;
      for (let i=0; i<this.regions.length; i++) {
        const r = this.regions[i], distance = Math.hypot(r.anchor.x-p.x,r.anchor.z-p.z);
        if (distance < 205) this.localRegions.push(i);
        else {
          r.field.mesh.visible = false;
          r.surface.mesh.visible=false;
          r.field.release();
        }
        if (distance < closest) { closest = distance; nearest = i; }
      }
      if (!this.localRegions.length) this.localRegions.push(nearest);
    }
    let best = Infinity, weightSum = 0;
    for (const i of this.localRegions) {
      const region = this.regions[i], a = region.anchor, field = region.field;
      const ox = p.x-a.x, oz = p.z-a.z;
      const distance = Math.hypot(ox,oz);
      // An anchor owns a stretch of ground ahead of the source camera.
      // Adjacent influences cross-fade continuously in their shared corridor.
      const along = ox*a.dx+oz*a.dz;
      const score = Math.hypot(ox-a.dx*clamp(along,0,30), oz-a.dz*clamp(along,0,30)) + Math.abs(along-7)*.09;
      const weight = 1 / Math.pow(1 + score/12, 3.5);
      region.atmosphereWeight = weight;
      weightSum += weight;
      this.skyTop.setRGB(this.skyTop.r+region.sky.top.r*weight,this.skyTop.g+region.sky.top.g*weight,this.skyTop.b+region.sky.top.b*weight);
      this.skyHorizon.setRGB(this.skyHorizon.r+region.sky.horizon.r*weight,this.skyHorizon.g+region.sky.horizon.g*weight,this.skyHorizon.b+region.sky.horizon.b*weight);
      if (score < best) { best = score; this.activeRegion = i; }
      const alive = distance < 188;
      field.mesh.visible = alive && this.mode !== 'voxel' && this.splats > 0;
      if (field.mesh.visible) {
        const uniforms = field.mesh.material.uniforms;
        uniforms.hybrid.value = this.mode === 'hybrid' ? 1 : 0;
        uniforms.intensity.value = this.mode === 'splat' ? Math.min(1,this.splats*1.45) : this.splats;
        const reveal = i === 0 ? 1 : smooth(performance.now()-field.created,0,900);
        uniforms.visibility.value = (1-smooth(distance,125,188))*reveal;
        field.mesh.renderOrder = 1000 - Math.round(distance);
      }
    }
    // Fade a distant source photograph as the player enters another
    // region, including where the sky leaves both depth fields visible.
    const dominantWeight = this.regions[this.activeRegion].atmosphereWeight;
    for (const i of this.localRegions) {
      const region = this.regions[i];
      if (!region.field.mesh.visible) continue;
      region.field.mesh.material.uniforms.visibility.value *= smooth(region.atmosphereWeight / dominantWeight, .006, .88);
    }
    this.morphState=this.liveViews?null:this.findPassage();
    if(this.morphState)this.morphEdits.update(this.camera.position);
    this.updatePhotoViews(this.morphState);
    if(this.liveViews){
      this.stampClip.update(this.camera);
      this.viewAtlas.update(this.camera,this.mode,this.splats,this.placingView?0:viewDt);
    }
    this.skyTop.multiplyScalar(1/weightSum);
    this.skyHorizon.multiplyScalar(1/weightSum);
    const amount = dt >= 1 ? 1 : 1-Math.exp(-dt*2.5);
    const skyUniforms = this.sky.material.uniforms;
    skyUniforms.topColor.value.lerp(this.skyTop,amount);
    skyUniforms.horizonColor.value.lerp(this.skyHorizon,amount);
    this.scene.fog.color.copy(skyUniforms.horizonColor.value);
  }

  emitStats() {
    if (!this.regions.length) return;
    const target = this.target();
    const material = target && BLOCKS.find(b => b.id === target.id);
    this.notify('onStats', {
      x: this.position.x, y: this.position.y, z: this.position.z,
      heading: (this.yaw/radians % 360 + 360) % 360,
      fps: Math.round(this.fps), region: this.activeRegion, morph:this.morphState,
      viewBlend:this.liveViews?this.viewAtlas.viewBlend(this.camera):
        {indices:this.stamps.length?[0]:[],weights:this.stamps.length?[1]:[],dominant:this.stamps.length?0:null},
      flying: this.flying, block: material?.name || material?.label || ''
    });
  }

  frame(now) {
    if (this.suspended) return;
    this.frameId = requestAnimationFrame(this.frame);
    const elapsed = (now-this.lastFrame)/1000;
    this.lastFrame = now;
    if (document.hidden) return;
    const lastRegion = this.regions[this.regions.length-1];
    const idle = !this.playing && !this.videoField.hasActivePlayback && !this.particles.length && !this.world.queue.length && !this.viewAtlas.animating &&
      lastRegion && now-lastRegion.field.created > 1200;
    if (idle && !this.drawRequested && now-this.lastDraw < 150) return;
    this.drawRequested = false;
    this.lastDraw = now;
    const dt = clamp(elapsed,0,.06);
    if (!idle && elapsed > 0 && elapsed < 1) this.fps = THREE.MathUtils.lerp(this.fps, 1/elapsed, .055);
    if(this.mobile&&this.playing&&this.raster.observe(elapsed))this.resize();
    if (this.regions.length) {
      if (this.playing) this.simulate(dt);
      this.updateFragments(dt);
      this.updateCamera();
      const wasBuilding = this.world.queue.length > 0;
      this.world.update(this.position,dt);
      const meshCount = this.world.group.children.length;
      if (Math.abs(meshCount-this.lastMeshCount) >= 8 ||
          ((wasBuilding || meshCount !== this.lastMeshCount) && !this.world.queue.length)) {
        this.lastMeshCount = meshCount;
        this.renderer.shadowMap.needsUpdate = true;
      }
      this.updateAtmosphere(dt,dt);
      const hit = this.playing && this.target();
      this.outline.visible = !!hit && this.mode !== 'splat';
      if (hit) this.outline.position.set(hit.x+.5,hit.y+.5,hit.z+.5);
      if (this.playing && this.heldAction && now >= this.heldAction.next) {
        this.interact(this.heldAction.place);
        this.heldAction.next = now+210;
      }
      this.statsTime += dt;
      if (this.statsTime > .16) { this.statsTime = 0; this.emitStats(); }
    }
    this.videoField.update(this.viewAtlas,this.camera,now);
    if(this.liveViews)this.world.terrainProjection.update(this.camera,this.viewAtlas,this.videoField,this.mode);
    this.renderer.render(this.scene,this.camera);
  }

  saveState() {
    this.editSnapshot ??= Object.freeze([...this.edits.values()]);
    return {
      version: 1, x: this.position.x, y: this.position.y, z: this.position.z,
      yaw: this.yaw, pitch: this.pitch, flying: this.flying, selected: this.slot,
      fov: this.fov, splats: this.splats, mode: this.mode,
      liveLens:this.liveLens,viewAspect:this.recalledAspect,viewOffsets:this.liveOffsets,
      viewNear:this.camera.near,viewFar:this.camera.far,
      guidedTo:this.guidedEdge?.to??null, edits: this.editSnapshot
    };
  }

  restoreState(state) {
    if (!state || !this.regions.length) return;
    for (const entry of state.edits || []) {
      if (!Array.isArray(entry) || entry.length !== 4 || !entry.every(Number.isInteger)) continue;
      const [x,y,z,id] = entry;
      if (id < 0 || id > BLOCKS.length) continue;
      this.world.setBlock(x,y,z,id,true);
      this.edits.set([x,y,z].join(','),Object.freeze([x,y,z,id]));
      this.morphEdits.mark(x,y,z);
      if(this.stamps.length)this.viewAtlas.maskCell(x,y,z);
      for (const r of this.regions) {r.field.maskCell(x,y,z);r.surface.maskCell(x,y,z);}
    }
    this.editSnapshot = null;
    this.editFieldDirty = true;
    if ([state.x,state.y,state.z].every(Number.isFinite)) this.position.set(state.x,state.y,state.z);
    if (Number.isFinite(state.yaw)) this.yaw = state.yaw;
    if (Number.isFinite(state.pitch)) this.pitch = clamp(state.pitch,-Math.PI/2+.009,Math.PI/2-.009);
    this.guidedEdge=!this.liveViews && Number.isInteger(state.guidedTo)?this.passages[state.guidedTo]??null:null;
    this.flying = !!state.flying;
    this.velocityY = 0;
    this.setMode(state.mode);
    this.setSplats(state.splats);
    this.setFov(state.fov);
    if(Number.isFinite(state.liveLens) && state.liveLens>0 && state.liveLens<180){
      this.liveLens=state.liveLens;
      if(Number.isFinite(state.viewNear)&&Number.isFinite(state.viewFar)&&state.viewNear>0&&state.viewFar>state.viewNear){
        this.camera.near=state.viewNear;this.camera.far=state.viewFar;
      }
      if(state.viewOffsets?.length===2&&state.viewOffsets.every(Number.isFinite))this.liveOffsets=state.viewOffsets.slice();
      this.recalledAspect=Number.isFinite(state.viewAspect)&&state.viewAspect>0?state.viewAspect:null;
      this.updateViewport();this.updateLens();
    }
    this.select(state.selected ?? 0);
    this.renderer.shadowMap.needsUpdate = true;
    this.updateCamera();
    this.updateAtmosphere(1);
    this.emitStats();
  }

  dispose() {
    this.pause();
    cancelAnimationFrame(this.frameId);
    this.disposeEvents.abort();
    this.resizeObserver.disconnect();
    this.videoField.dispose();
    this.world.dispose();this.viewAtlas.dispose();this.stampClip.dispose();
    for (const { field, surface } of this.regions) {field.dispose();surface.dispose();}
    this.liveField?.dispose();
    this.morphEdits.dispose();
    this.editField?.dispose();
    for (const obj of [this.sky,this.clouds,this.outline,this.fragments]) {
      obj.geometry.dispose(); obj.material.dispose();
    }
    this.sun.shadow.dispose();
    this.renderer.dispose();
  }
}
