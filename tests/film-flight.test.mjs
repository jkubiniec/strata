import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {flightStops,flightDuration,flightPose} from '../dist/flight-path.js';

test('the guided flight starts and finishes at each saved camera with native framing',()=>{
  for(const [index,t] of [[0,0],[1,flightDuration]]){
    const {frame,...pose}=flightPose(t);
    assert.deepEqual(pose,flightStops[index]);
    assert.deepEqual(frame,{source:index,amount:1});
  }
  let previous=flightPose(0);
  for(let t=.05;t<flightDuration;t+=.05){
    const p=flightPose(t);
    assert.ok(Math.hypot(p.x-previous.x,p.y-previous.y,p.z-previous.z)<1);
    assert.ok(p.frame.amount>=0&&p.frame.amount<=1);
    previous=p;
  }
});

test('both public films have matching video, poster, depth and motion assets',async()=>{
  const folder=new URL('../dist/assets/flight/',import.meta.url);
  for(const name of ['apollo','discovery']){
    const load=ext=>readFile(new URL(name+ext,folder));
    const [movie,poster,study,motion]=await Promise.all(['.mp4','.jpg','-study.bin','-motion.bin'].map(load));
    assert.equal(movie.toString('ascii',4,8),'ftyp');
    assert.equal(poster.readUInt16BE(),0xffd8);
    const header=b=>JSON.parse(b.toString('utf8',4,4+b.readUInt32LE()));
    const photo=header(study),clip=header(motion);
    assert.equal(clip.id,'strata-flight-'+name);
    assert.equal(photo.width,clip.width);
    assert.equal(photo.height,clip.height);
    assert.ok(photo.featureShape.channels>0&&clip.frames.length>=24);
    assert.equal(motion.length,4+motion.readUInt32LE()+4*clip.gridW*clip.gridH*clip.frames.length);
  }
});
