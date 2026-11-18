import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../dist/vendor/three.module.js';
import {captureStamp,projectStamp,unprojectStamp,cameraStamp,ViewVolumeAtlas} from '../dist/view-volume.js';
import {fuseAppearance} from '../dist/photo-fusion.js';
import {VoxelWorld} from '../dist/world.js';

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

test('walking a camera closer gives its observed surface more influence',async()=>{
  const atlas=new ViewVolumeAtlas();
  const pose=z=>cameraStamp({eye:{x:0,y:12,z},yaw:0,pitch:0,fov:62,aspect:1.5});
  try{
    await atlas.add(source([164,85,38]),pose(0),0,{animate:false});
    await atlas.add(source([36,130,167]),pose(-30),1,{animate:false});
    const [far,near]=atlas.contributorsAt(0,12,-55);
    assert.ok(far.weight>0 && near.weight>far.weight*2);
    assert.ok(Math.abs(far.weight+near.weight-1)<1e-6);
  }finally{atlas.dispose();}
});

test('overlapping sky and pitched captures retain visible, editable terrain through the frame edge',async()=>{
  const atlas=new ViewVolumeAtlas(),world=new VoxelWorld(new THREE.Group());
  const capture=(yaw,pitch)=>cameraStamp({eye:{x:0,y:14,z:0},yaw,pitch,fov:64,aspect:1.6});
  const sky=source([85,144,198]);sky.skyMask.fill(1);
  const point={x:10,z:-29},cx=point.x>>4,cz=point.z>>4;
  const topAt=(x,z)=>{
    for(let y=world.getGround(x,z)-1;y>=-11;y--)if(world.getBlock(x,y,z))return y;
    return undefined;
  };
  const add=async(profile,pose)=>{
    await atlas.add(profile,pose,undefined,{animate:false});
    world.registerView(atlas,atlas.lastBounds);
  };
  try{
    const outside=world.rawBlock(-120,world.getGround(-120,-29)-1,-29);
    await add(sky,capture(0,0));
    const base=world.getGround(point.x,point.z);
    assert.equal(atlas.sampleCell(point.x,base-1,point.z),0);
    const skyFloor=topAt(point.x,point.z);
    assert.notEqual(skyFloor,undefined);
    assert.equal(world.rawBlock(point.x,skyFloor,point.z),world.column(point.x,point.z).top);
    await add(source([192,104,46],.1),capture(.25,-.32));
    // Every column across both capture edges and beyond the far shell
    // retains a substrate. Returning to an edited column keeps the edit.
    for(let z=0;z>=-115;z--)assert.notEqual(topAt(point.x,z),undefined,'missing ground at '+z);
    assert.equal(world.rawBlock(-120,world.getGround(-120,-29)-1,-29),outside);
    const y=topAt(point.x,point.z);
    const photoColor=atlas.supportingGround(point.x+.5,base,point.z+.5).tint;
    assert.notEqual(photoColor,world.column(point.x,point.z).top&0xffffff);
    assert.equal(world.getTint(point.x,y,point.z),photoColor);
    assert.equal(world.getBlock(point.x,y+1,point.z),0);
    world.makeChunk(cx,cz);
    const geometry=world.meshes.get(cx+','+cz).children[0].geometry;
    const vertices=geometry.getAttribute('position'),normals=geometry.getAttribute('normal');
    const lx=point.x-cx*16,lz=point.z-cz*16;
    let floorFace=false;
    for(let i=0;i<vertices.count;i+=4){
      if(normals.getY(i)!==1 || vertices.getY(i)!==y+1)continue;
      const centerX=(vertices.getX(i)+vertices.getX(i+2))*.5;
      const centerZ=(vertices.getZ(i)+vertices.getZ(i+2))*.5;
      if(centerX===lx+.5 && centerZ===lz+.5){floorFace=true;break;}
    }
    assert.ok(floorFace,'the collision floor must have a visible top face');
    assert.equal(world.setBlock(point.x,y,point.z,0),true);
    assert.equal(world.getBlock(point.x,y,point.z),0);
    assert.ok(world.getBlock(point.x,y-1,point.z));
    assert.equal(world.setBlock(point.x,y+1,point.z,5),true);
    await add(source([30,95,110]),capture(-.21,-.14));
    assert.equal(world.getBlock(point.x,y,point.z),0);
    assert.equal(world.getBlock(point.x,y+1,point.z),5);
    const shell=[...atlas.cells.values()].find(c=>c.y>world.getGround(c.x,c.z)+1);
    assert.ok(shell);assert.equal(world.getBlock(shell.x,shell.y,shell.z),shell.id);
  }finally{world.dispose();atlas.dispose();}
});

test('an already built overlap follows the viewer reversibly across all three source cameras',async()=>{
  const atlas=new ViewVolumeAtlas(),camera=new THREE.PerspectiveCamera(60,1.5,.07,240);
  function move(x,z){
    camera.position.set(x,12,z);camera.updateMatrixWorld(true);atlas.update(camera,'hybrid',.7,1/60);
    const layer=atlas.records[0].layer;
    const {indices,weights}=atlas.viewBlend(camera);
    return {offset:layer.motion.offsetAt(.5,.5),colors:layer.motion.pigment.image.data.slice(),influence:Object.fromEntries(indices.map((id,i)=>[id,weights[i]]))};
  }
  try{
    const capture=(x,z)=>cameraStamp({eye:{x,y:12,z},yaw:0,pitch:0,fov:60,aspect:1.5});
    await atlas.add(source([215,56,37],.22),capture(0,0),0,{animate:false});
    assert.equal(atlas.records[0].layer.motion,null);
    await atlas.add(source([60,138,77],.65),capture(3,-8),1,{animate:false});
    await atlas.add(source([48,70,225],.36),capture(7,-17),2,{animate:false,prepareReplay:true});
    const a=move(0,0),b=move(3,-8),c=move(7,-17);
    const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
    assert.ok(distance(a.offset,b.offset)>1);
    assert.ok(distance(b.offset,c.offset)>1);
    assert.ok(a.influence[0]>c.influence[0] && c.influence[2]>a.influence[2]);
    assert.notDeepEqual(a.colors,b.colors);
    assert.notDeepEqual(b.colors,c.colors);
    const layer=atlas.records[0].layer;
    assert.equal(layer.solid.material.uniforms.motionOffsets.value,layer.motion.offsets);
    assert.equal(layer.gaussian.material.uniforms.motionOffsets.value,layer.motion.offsets);
    assert.deepEqual(layer.solid.quaternion.toArray(),[0,0,0,1]);
    assert.equal(atlas.animating,false);
    assert.deepEqual(move(0,0),a);
    assert.equal(atlas.replayLastPlacement(),true);atlas.update(camera,'hybrid',.7,2);
    assert.equal(atlas.animating,false);assert.deepEqual(move(7,-17),c);
  }finally{atlas.dispose();}
});

test('multiple photos from the same pose can be traversed by walking along the capture axis',async()=>{
  const atlas=new ViewVolumeAtlas(),camera=new THREE.PerspectiveCamera(62,1.5,.07,190);
  try{
    const pose=cameraStamp({eye:{x:0,y:10,z:0},yaw:0,pitch:0,fov:62,aspect:1.5});
    await atlas.add(source([200,90,30],.12),pose,0,{animate:false});
    await atlas.add(source([20,47,155],.76),pose,1,{animate:false});
    const sample=z=>{
      camera.position.set(0,10,z);camera.updateMatrixWorld(true);
      atlas.update(camera,'voxel',0,.06);
      return atlas.records[0].layer.motion.offsetAt(.5,.5).z;
    };
    const start=sample(0),end=sample(-28);
    assert.ok(Math.abs(end-start)>6);
    assert.equal(sample(0),start);
  }finally{atlas.dispose();}
});

test('the previous film retains its feature match when an older overlapping capture has a closer heading',()=>{
  const atlas=new ViewVolumeAtlas(),records=[];
  try{
    for(const [id,yaw] of [0,.30,.04].entries()){
      records.push(atlas.prepareRecord(source([80+id*14,110,160]),frame(yaw),id,records));
    }
    assert.deepEqual([...records[2].flows.keys()].sort(),[0,1]);
    assert.ok(records[1].flows.has(2));
  }finally{atlas.dispose();}
});
