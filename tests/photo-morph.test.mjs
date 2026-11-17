import assert from 'node:assert/strict';
import test from 'node:test';
import { correspondence } from '../dist/morph.js';

function stripedSubject(centerX) {
  const gridW=128, gridH=80;
  const rgb=new Uint8Array(gridW*gridH*3);
  const depth=new Float32Array(gridW*gridH);
  for(let y=0;y<gridH;y++)for(let x=0;x<gridW;x++){
    const i=y*gridW+x;
    const foreground=Math.abs((x+.5)/gridW-centerX)<.09 && Math.abs((y+.5)/gridH-.5)<.16;
    const stripe=Math.floor(y/6)%2;
    rgb.set(foreground ? [208+stripe*35,39,32] : [59,105,146],i*3);
    depth[i]=foreground ? .85 : .2;
  }
  return {gridW,gridH,rgb,depth,detections:[]};
}

function destination(flow,column,row) {
  const index=(row*flow.cols+column)*2;
  return [flow.uv[index],flow.uv[index+1]];
}

test('an automatically matched subject travels to its new location',()=>{
  const flow=correspondence(stripedSubject(.25),stripedSubject(.75),33,25);
  const [x,y]=destination(flow,8,12);
  assert.ok(Math.abs(x-.75)<.055,`subject moved to x=${x}`);
  assert.ok(Math.abs(y-.50)<.045,`subject moved to y=${y}`);
  assert.deepEqual(destination(flow,0,0),[0,0]);
  assert.deepEqual(destination(flow,32,24),[1,1]);
});

test('a user can redirect an otherwise stationary subject',()=>{
  const source=stripedSubject(.5);
  const original=destination(correspondence(source,source,33,25),16,12);
  const guide={x:.5,y:.5,tx:.72,ty:.32};
  const steered=destination(correspondence(source,source,33,25,[guide]),16,12);
  assert.ok(Math.hypot(original[0]-.5,original[1]-.5)<.015);
  assert.ok(Math.hypot(steered[0]-guide.tx,steered[1]-guide.ty)<.025);
});
