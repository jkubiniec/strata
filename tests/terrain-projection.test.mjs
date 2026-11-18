import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../dist/vendor/three.module.js';
import {captureStamp,unprojectStamp} from '../dist/view-volume.js';
import {TerrainProjection} from '../dist/terrain-projection.js';

test('terrain samples the same offset camera rays as the stamp and releases them away from capture',()=>{
  const camera=new THREE.PerspectiveCamera(61,1.7,.07,330);
  camera.position.set(8,14,-21);
  camera.rotation.set(.17,-.35,0,'YXZ');
  camera.setViewOffset(1700,1000,140,85,1300,705);
  const s=captureStamp(camera);
  const record={s,profile:{},cropX:.92,cropY:1,
    layer:{texture:{},resident:true,root:{visible:true},uniforms:{placement:{value:1}}}};
  const projection=new TerrainProjection({}),u=projection.uniforms;
  const update=()=>projection.update(camera,{stamps:[record]},{sources:new Map()},'hybrid');
  update();
  assert.equal(u.terrainSource0.value,record.layer.texture);
  assert.ok(u.terrainSettings0.value.z>.98);
  for(const [x,y] of [[.05,.2],[.5,.5],[.77,.95]]){
    const p=unprojectStamp(s,x,y,8);
    const uv=new THREE.Vector4(p.x,p.y,p.z,1).applyMatrix4(u.terrainEye0.value);
    assert.ok(Math.abs(x-uv.x/uv.z)<1e-8 && Math.abs(y-uv.y/uv.z)<1e-8);
  }
  camera.position.x+=4;update();
  assert.ok(u.terrainSettings0.value.z>0 && u.terrainSettings0.value.z<.8);
  assert.equal(u.terrainTravel0.value,4);
  camera.position.x+=9;update();assert.equal(u.terrainSettings0.value.z,0);
  camera.position.x-=13;camera.rotateY(Math.PI);update();assert.equal(u.terrainSource0.value,null);
});
