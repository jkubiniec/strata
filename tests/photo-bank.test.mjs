import test from 'node:test';
import assert from 'node:assert/strict';
import {PhotoBank,nextReady} from '../dist/photo-bank.js';

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
