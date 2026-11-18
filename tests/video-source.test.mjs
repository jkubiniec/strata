import test from 'node:test';
import assert from 'node:assert/strict';
import { isVideoFile, propagateVideoDepth, videoShotChange } from '../dist/video-source.js';

test('phone videos with a missing MIME type join the media bank', () => {
  assert.equal(isVideoFile({type:'',name:'IMG_0831.MOV'}),true);
  assert.equal(isVideoFile({type:'video/webm',name:'clip'}),true);
  assert.equal(isVideoFile({type:'image/heic',name:'IMG_0831.HEIC'}),false);
});

function frame(left) {
  const width=48,height=24,rgb=new Uint8Array(width*height*3),depth=new Uint8Array(width*height);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const i=x+y*width,subject=x>=left&&x<left+10&&y>=6&&y<18;
    rgb.set(subject?[214,44+(x-left)*3,24+y]:[44,95+y,150],3*i);
    depth[i]=subject?201:39;
  }
  return {width,height,rgb,depth};
}

test('motion tracking moves the near surface with the subject and preserves still geometry', () => {
  const a=frame(12),b=frame(17);
  assert.equal(videoShotChange(a.rgb,b.rgb),false);
  assert.deepEqual(propagateVideoDepth(a,a.rgb,a.width,a.height),a.depth);
  const next=propagateVideoDepth(a,b.rgb,a.width,a.height);
  assert.ok(next[25+12*a.width]>170,'new foreground should carry near depth');
  assert.ok(next[13+12*a.width]<65,'revealed background should recover far depth');
  assert.equal(next[5],39,'unchanged background is stationary');
});

test('a hard cut reconstructs the next shot without carrying the last foreground', () => {
  const a=frame(12), red=new Uint8Array(a.rgb.length);
  for(let i=0;i<red.length;i+=3)red[i]=250;
  assert.equal(videoShotChange(a.rgb,red),true);
  const d=propagateVideoDepth(a,red,a.width,a.height,true);
  assert.equal(d[15+9*a.width],d[29+9*a.width]);
});
