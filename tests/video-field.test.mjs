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

test('eleven visible desktop films animate together while phone keeps its four-source budget', async()=>{
  const still={width:240,height:160,detail:.4,gridW:w,gridH:h,rgb:rgb(90),depth:new Float32Array(w*h).fill(.4),skyMask:new Uint8Array(w*h)};
  const entries=Array.from({length:11},(_,id)=>({
    id,frame:cameraStamp({eye:{x:200*id,y:5,z:0},aspect:1.5,fov:45}),
    profile:{...still,video:{id:'film-'+id,duration:3,width:240,height:160,gridW:w,gridH:h,
      frames:[frame(0,90,90),frame(1,100+id,120+id),frame(2,175,220)]}}
  }));
  const atlas=new ViewVolumeAtlas(phoneBudget);
  const desktop=new VideoField(),phone=new VideoField(true),camera={position:{x:0,y:5,z:0}};
  try{
    await atlas.restore(entries);
    desktop.setPlaying(false);
    for(const {profile} of entries)desktop.seek(profile.video.id,1.25);
    desktop.update(atlas,camera);
    assert.equal(desktop.activeCount,11);
    for(const {id,layer} of atlas.records){
      const uniforms=layer.solid.material.uniforms;
      assert.ok(uniforms.videoGain0.value>0);
      assert.equal(uniforms.videoMix0.value,.25);
      assert.deepEqual([...uniforms.videoA0.value.image.data.slice(0,4)],[120+id,120+id,120+id,100+id]);
    }
    phone.update(atlas,camera);
    assert.equal(phone.activeCount,4);
    assert.equal(atlas.records.filter(r=>r.layer.uniforms.videoGain0.value>0).length,4);
    for(const {layer} of atlas.records.slice(6))layer.root.visible=false;
    desktop.update(atlas,camera,performance.now()+2000);
    assert.equal(desktop.activeCount,6);
    assert.equal(desktop.sources.get('film-10').textures,null);
    assert.equal(desktop.time('film-10'),1.25);
  }finally{desktop.dispose();phone.dispose();atlas.dispose();}
});

test('a desktop film still moves its own surface where two neighboring videos outrank it',async()=>{
  const still={width:240,height:160,detail:.4,gridW:w,gridH:h,rgb:rgb(90),depth:new Float32Array(w*h).fill(.4),skyMask:new Uint8Array(w*h)};
  const entries=[0,4,8].map((x,id)=>({
    id,frame:cameraStamp({eye:{x,y:5,z:0},aspect:1.5,fov:45}),
    profile:{...still,video:{id:'overlap-'+id,duration:3,width:240,height:160,gridW:w,gridH:h,
      frames:[frame(0,90,90),frame(1,110+id,140+id)]}}
  }));
  const atlas=new ViewVolumeAtlas(phoneBudget),field=new VideoField();
  try{
    await atlas.restore(entries);
    const layer=atlas.records[2].layer,own=layer.ownVideoSample;
    assert.equal(own.record,atlas.records[2]);
    assert.equal(layer.videoSamples.length,3);
    for(const sample of layer.videoSamples)sample.maximum = sample === own ? .02 : 1;
    field.setPlaying(false);field.seek(own.clip.id,1);
    field.update(atlas,{position:{x:0,y:5,z:0}});
    assert.equal(layer.uniforms.videoMap1.value,own.texture);
    assert.equal(layer.uniforms.videoA1.value.image.data[3],112);
    assert.notEqual(layer.uniforms.videoMap0.value,own.texture);
  }finally{field.dispose();atlas.dispose();}
});

test('the viewer reversibly reweights the playing films on the same hybrid surface',async()=>{
  const entries=[0,15].map((x,id)=>({
    id,frame:cameraStamp({eye:{x,y:5,z:0},aspect:1.6,fov:65}),
    profile:{width:240,height:160,detail:.4,gridW:w,gridH:h,rgb:rgb(60+id*75),depth:new Float32Array(w*h).fill(.4),skyMask:new Uint8Array(w*h),
      video:{id:'clip'+id,duration:3,width:240,height:160,gridW:w,gridH:h,frames:[frame(0,100,50+id*100),frame(1,120,100+id*25)]}}
  }));
  const atlas=new ViewVolumeAtlas(phoneBudget),field=new VideoField();
  try{
    await atlas.restore(entries);
    const layer=atlas.stamps[0].layer,uniforms=layer.uniforms;
    const gainsAt=x=>{
      field.update(atlas,{position:{x,y:5,z:0}});
      return layer.videoSamples.map(sample=>{
        const slot=uniforms.videoMap0.value===sample.texture?0:1;
        return uniforms['videoGain'+slot].value;
      });
    };
    const left=gainsAt(0),middle=gainsAt(7.5),right=gainsAt(15);
    assert.ok(left[0]>left[1]*8 && right[1]>right[0]*8);
    assert.ok(Math.abs(middle[0]-middle[1])<1e-6);
    assert.deepEqual(gainsAt(0),left);
    assert.equal(layer.gaussian.material.uniforms,layer.solid.material.uniforms);
  }finally{field.dispose();atlas.dispose();}
});
