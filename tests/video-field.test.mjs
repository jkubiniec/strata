import test from 'node:test';
import assert from 'node:assert/strict';
import {VideoField,temporalPair} from '../dist/video-field.js';
import {ViewVolumeAtlas,cameraStamp} from '../dist/view-volume.js';
import {phoneBudget} from '../dist/performance-profile.js';

const w=12,h=8;
const rgb=v=>new Uint8Array(w*h*3).fill(v);
const frame=(time,d,c)=>({time,depth:new Uint8Array(w*h).fill(d),rgb:rgb(c)});

test('video samples interpolate within a shot and change shots at the actual cut',()=>{
  const frames=[frame(0,10,20),frame(.6,50,80),{...frame(1.2,110,210),cut:true}];
  assert.deepEqual(temporalPair(frames,.3),{a:0,b:1,mix:.5});
  assert.deepEqual(temporalPair(frames,1.1),{a:1,b:2,mix:0});
  assert.deepEqual(temporalPair(frames,1.2),{a:2,b:2,mix:0});
});

test('a video painted at an existing camera moves its shared shell and keeps one reversible clock across placements',async()=>{
  const still={width:240,height:160,detail:.4,gridW:w,gridH:h,rgb:rgb(100),depth:new Float32Array(w*h).fill(.4),skyMask:new Uint8Array(w*h)};
  const video={...still,video:{id:'sample',duration:3,width:240,height:160,gridW:w,gridH:h,
    frames:[frame(0,102,100),frame(1,200,245),frame(2,50,30)]}};
  const camera={position:{x:0,y:5,z:0}},stamp=x=>cameraStamp({eye:{x,y:5,z:0},aspect:1.5,fov:45});
  const atlas=new ViewVolumeAtlas(phoneBudget),field=new VideoField(true);
  try{
    await atlas.restore([{id:0,profile:still,frame:stamp(0)},{id:1,profile:video,frame:stamp(0)},{id:2,profile:video,frame:stamp(5)}]);
    const layer=atlas.records[0].layer;
    assert.equal(atlas.records[1].representative,atlas.records[0]);
    assert.ok(layer.videoSamples.some(s=>s.record.id===1&&s.maximum>0));
    field.setPlaying(false);field.seek('sample',1.25);field.update(atlas,camera);
    assert.equal(field.sources.size,1);
    assert.equal(field.time('sample'),1.25);
    assert.equal(layer.solid.material.uniforms.videoMix0.value,.25);
    assert.equal(layer.gaussian.material.uniforms.videoA0.value.image.data[3],200);
    assert.equal(layer.solid.material.uniforms.videoB0.value.image.data[3],50);
    const initialTexture=layer.uniforms.videoReference0.value;
    assert.equal(initialTexture.image.data[3],102);
    field.seek('sample',0);field.update(atlas,camera);
    assert.equal(layer.uniforms.videoMix0.value,0);
    assert.deepEqual(layer.uniforms.videoA0.value.image.data,initialTexture.image.data);
    assert.equal(field.hasActivePlayback,false);
  }finally{field.dispose();atlas.dispose();}
});
