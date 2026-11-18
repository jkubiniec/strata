import test from 'node:test';
import assert from 'node:assert/strict';
import {mapLayout} from '../dist/placements.js';

const placement=(x,y,z,yaw=0)=>({capture:{eye:{x,y,z},yaw,fov:65,aspect:1.5}});

test('a sitemap pin preserves every angle and altitude at a shared location',()=>{
  const records=[placement(0,2,0),placement(0,5,0,.9),placement(0,40,0,-.5),placement(100,2,50)];
  for(const width of [300,600]){
    const {pins,shapes}=mapLayout(records,records[0].capture,width,190);
    assert.deepEqual(pins.map(p=>p.indices),[[0,1,2],[3]]);
    assert.deepEqual(shapes[0][0],shapes[1][0]);
    assert.notDeepEqual(shapes[0][2],shapes[1][2]);
  }
});

test('a distant camera and a long placement trail fit on a phone map without dropping views',()=>{
  const records=Array.from({length:1200},(_,i)=>placement(i*32,i%11,Math.sin(i)*180));
  const {pins,player,shapes}=mapLayout(records,placement(-1200,16,-250).capture,300,154);
  assert.deepEqual(pins.flatMap(p=>p.indices).sort((a,b)=>a-b),records.map((_,i)=>i));
  for(const {x,y} of [player,...shapes.flat()])assert.ok(x>=20&&x<=280&&y>=20&&y<=134);
  for(let i=0;i<pins.length;i++)for(const other of pins.slice(i+1)){
    assert.ok(Math.abs(other.x-pins[i].x)>=44||Math.abs(other.y-pins[i].y)>=44);
  }
});
