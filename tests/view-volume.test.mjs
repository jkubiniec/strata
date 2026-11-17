import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../dist/vendor/three.module.js';
import {captureStamp,projectStamp,unprojectStamp,cameraStamp,ViewVolumeAtlas} from '../dist/view-volume.js';
import {fuseAppearance} from '../dist/photo-fusion.js';

function source(rgb,depth=.55) {
  const w=24,h=18;
  return {width:320,height:240,gridW:w,gridH:h,detail:0,
    rgb:Uint8Array.from({length:w*h*3},(_,i)=>rgb[i%3]),
    depth:new Float32Array(w*h).fill(depth),skyMask:new Uint8Array(w*h),detections:[]};
}
function frame(yaw=0){
  return cameraStamp({eye:{x:3.25,y:11.75,z:-4.5},yaw,pitch:.08,fov:54,aspect:4/3,near:.07,far:240});
}

test('capture projection includes camera translation, pitch and off-centre lens',()=>{
  const camera=new THREE.PerspectiveCamera(58,1.4,.07,180);
  camera.position.set(17,13,-23);camera.rotation.order='YXZ';camera.rotation.set(.23,-.41,0,'YXZ');
  camera.setViewOffset(1400,1000,90,110,900,780);camera.updateMatrixWorld(true);
  const capture=captureStamp(camera);
  for(const [u,v] of [[.11,.72],[.76,.26],[.5,.5]]){
    const p=unprojectStamp(capture,u,v,41);
    const actual=new THREE.Vector3(p.x,p.y,p.z).project(camera);
    assert.ok(Math.abs(actual.x-(2*u-1))<1e-9 && Math.abs(actual.y-(1-2*v))<1e-9);
    assert.ok(projectStamp(capture,p.x,p.y,p.z).inside);
  }
});

test('overlapping captures all contribute while a disjoint addition preserves prior cells',async()=>{
  const atlas=new ViewVolumeAtlas(),north=frame(0);
  try{
    await atlas.add(source([195,70,40]),north,0,{animate:false});
    const originalLayer=atlas.records[0].layer,originalCount=originalLayer.cells.size;
    await atlas.add(source([80,145,66]),frame(Math.PI),1,{animate:false});
    assert.equal(atlas.records[0].layer,originalLayer);
    assert.equal(originalLayer.cells.size,originalCount);
    await atlas.add(source([28,73,198],.7),frame(.22),2,{animate:false});
    await atlas.add(source([205,143,43],.35),frame(.44),3);
    const p=unprojectStamp(frame(.20),.5,.5,36);
    const hits=atlas.contributorsAt(p.x,p.y,p.z);
    assert.deepEqual(hits.map(h=>h.id),[0,2,3]);
    assert.ok(Math.abs(hits.reduce((n,h)=>n+h.weight,0)-1)<1e-5);
    assert.equal(atlas.animating,true);atlas.update(null,'hybrid',.65,.25);
    assert.ok(atlas.transitionProgress>0 && atlas.transitionProgress<1);
    const solid=atlas.records[2].layer.solid;
    assert.deepEqual(solid.quaternion.toArray(),[0,0,0,1]);
    const normals=solid.geometry.getAttribute('normal');
    for(let i=0;i<normals.count;i++)assert.equal(Math.abs(normals.getX(i))+Math.abs(normals.getY(i))+Math.abs(normals.getZ(i)),1);
    const cells=solid.geometry.getAttribute('cellCenter'),start=solid.geometry.getAttribute('startCenter');
    assert.equal(start.count,cells.count);
    for(let i=0;i<Math.min(100,cells.count);i++)assert.equal(cells.getX(i)-Math.floor(cells.getX(i)),.5);
  }finally{atlas.dispose();}
});

test('a single material retains its color and uniform three-way overlap respects all weights',()=>{
  const colors=[[40,80,120],[100,180,50],[140,50,190]],weights=[.25,.45,.30];
  const neighbors=colors.map(c=>({source:{width:1,height:1,stride:3,data:Uint8Array.from(c)}}));
  const maps=weights.map(weight=>Float32Array.from(Array.from({length:4},()=>[.5,.5,weight]).flat()));
  const r={source:neighbors[0].source,cropX:1,cropY:1,s:{aspect:1.5}};
  const blend=fuseAppearance(r,{w:1,h:1,maps,neighbors});
  const expected=colors[0].map((_,c)=>Math.round(colors.reduce((n,v,i)=>n+v[c]*weights[i],0)));
  assert.deepEqual([...blend.data.subarray(0,3)],expected);
  assert.ok(blend.data[3]>0);
  const single=fuseAppearance(r,{w:1,h:1,maps:[maps[0]],neighbors:neighbors.slice(0,1)});
  assert.deepEqual([...single.data.subarray(0,4)],[...colors[0],0]);
});
