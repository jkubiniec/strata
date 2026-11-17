import test from 'node:test';
import assert from 'node:assert/strict';
import { AdaptiveRaster, phoneBudget } from '../dist/performance-profile.js';
import { ViewVolumeAtlas, cameraStamp } from '../dist/view-volume.js';

test('phone raster scale responds to sustained frame cost and preserves its bounds',()=>{
  const raster=new AdaptiveRaster();
  assert.equal(raster.observe(.2),false);
  // A switch to a background tab resets the sample window.
  assert.equal(raster.observe(1),false);
  for(let i=0;i<250;i++)raster.observe(.05);
  assert.equal(raster.scale,phoneBudget.minPixelRatio);
  for(let i=0;i<120;i++)raster.observe(1/60);
  assert.equal(raster.scale,phoneBudget.minPixelRatio);
  for(let i=0;i<3600;i++)raster.observe(1/60);
  assert.equal(raster.scale,1);
});

test('a batched phone restore retains all photo neighbors, reversible geometry and replay',async()=>{
  const atlas=new ViewVolumeAtlas(phoneBudget);
  const pose=(x,yaw=0)=>cameraStamp({eye:{x,y:12,z:0},yaw,pitch:0,fov:62,aspect:1.4});
  const source=(rgb,d)=>({width:800,height:600,detail:.65,gridW:22,gridH:16,
    rgb:Uint8Array.from({length:22*16*3},(_,i)=>rgb[i%3]),
    skyMask:new Uint8Array(22*16),depth:new Float32Array(22*16).fill(d)});
  const record=(id,x,color,depth,yaw=0)=>({id,frame:pose(x,yaw),profile:source(color,depth)});
  const entries=[
    record(0,-9,[151,84,32],.36),record(1,0,[169,30,110],.51),
    record(2,10,[48,112,175],.67),record(3,10,[38,161,92],.71)
  ];
  try{
    await atlas.restore(entries);
    assert.deepEqual(atlas.records.map(r=>r.id),[0,1,2,3]);
    assert.equal(atlas.records[3].representative,atlas.records[2]);
    assert.deepEqual(atlas.contributorsAt(0,12,-40).map(c=>c.id),[0,1,2,3]);
    const layer=atlas.records[1].layer;
    assert.equal(layer.solid.geometry.index.count,18);
    assert.ok(layer.solid.geometry.instanceCount>100&&layer.gaussian.geometry.instanceCount>100);
    assert.ok(layer.image.width<=phoneBudget.textureSide);
    const motion=layer.motion;
    motion.update({x:-9,y:12,z:0});const before=motion.offsetAt(.5,.5);
    motion.update({x:10,y:12,z:0});assert.notDeepEqual(motion.offsetAt(.5,.5),before);
    motion.update({x:-9,y:12,z:0});assert.deepEqual(motion.offsetAt(.5,.5),before);
    await atlas.add(source([60,80,170],.44),pose(13,.2),4,{animate:false,prepareReplay:true});
    assert.equal(atlas.replayLastPlacement(),true);
    assert.equal(atlas.records.length,5);
  }finally{atlas.dispose();}
});
