import test from 'node:test';
import assert from 'node:assert/strict';
import {PhotoBank,nextReady,WalkingPlacement,sameAutoView} from '../dist/photo-bank.js';

const pose=(x=0,yaw=0,pitch=0)=>({x,y:3,z:0,yaw:yaw*Math.PI/180,pitch:pitch*Math.PI/180});

test('automatic photo walking responds to displacement and pan, then waits for new movement',()=>{
  const walk=new WalkingPlacement();
  walk.reset(pose());
  assert.equal(walk.update(pose(11),1000,true),false);
  assert.equal(walk.update(pose(12.1),1250,true),true);
  assert.equal(walk.update(pose(13,42),1500,true),false);
  assert.equal(walk.update(pose(13,50),4000,false),false);
  assert.equal(walk.update(pose(13,50),4500,true),false);
  assert.equal(walk.update(pose(13,55),5000,true),true);
  assert.equal(walk.update(pose(13,55),8000,true),false);
  assert.equal(walk.update(pose(13,55,36),9000,true),true);
  walk.reset(pose(32,359));
  assert.equal(walk.update(pose(32,2),20000,true),false);
});

test('automatic placement reuses the same view and distinguishes meaningful new positions and angles',()=>{
  assert.equal(sameAutoView(pose(0,359),pose(1,1)),true);
  assert.equal(sameAutoView(pose(0,0,89),pose(1,180,89)),true);
  assert.equal(sameAutoView(pose(0),pose(4)),false);
  assert.equal(sameAutoView(pose(0),pose(0,9)),false);
});

test('one tap consumes one ready entry, wraps and resumes from the saved cursor',()=>{
  const items=[{id:'one',profile:{}},{id:'two'},{id:'three',profile:{}}];
  const bank=new PhotoBank(null,()=>{},()=>{});
  bank.items=items;
  assert.deepEqual([bank.take().id,bank.take().id,bank.take().id],['one','three','one']);
  const saved=bank.lastId;
  items[1].profile={};
  assert.equal(nextReady(items,saved).id,'two');
  assert.equal(nextReady([],saved),null);
});

test('files appended during preparation stay in order and unreadable files do not block the bank',async()=>{
  let release,complete;
  const first=new Promise(resolve=>release=resolve);
  const drained=new Promise(resolve=>complete=resolve);
  const bank=new PhotoBank(async file=>{
    if(file.name==='broken')throw Error('unreadable');
    if(file.name==='first')await first;
    return {profile:{name:file.name}};
  },()=>{if(bank.items.length===3&&bank.items.every(item=>!item.file))complete();},()=>{});
  bank.add([{name:'first'},{name:'broken'}]);
  bank.add([{name:'last'}]);
  assert.equal(bank.next(),null);
  release();await drained;
  assert.deepEqual(bank.items.map(item=>item.name),['first','broken','last']);
  assert.equal(bank.items[1].failed,true);
  assert.deepEqual([bank.take().name,bank.take().name,bank.take().name],['first','last','first']);
});
