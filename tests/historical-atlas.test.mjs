import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {shuffledAtlas} from '../dist/history-atlas.js';
import {makeWalk} from '../dist/walk-route.js';

const assets=new URL('../dist/assets/history/',import.meta.url);
const entries=(await Promise.all(['a','b'].map(async group=>JSON.parse(await readFile(new URL('collection-'+group+'.json',assets),'utf8'))))).flat();

test('every archival source has a record, local image and matching learned depth study',async()=>{
  assert.ok(entries.length>=50);
  assert.equal(new Set(entries.map(e=>e.id)).size,entries.length);
  for(const item of entries){
    assert.equal(item.image,'./assets/history/'+item.id+'.jpg');
    assert.ok(item.rights&&item.credit&&item.year&&item.title&&item.description);
    assert.equal(new URL(item.source).protocol,'https:');
    const [image,study]=await Promise.all([readFile(new URL(item.id+'.jpg',assets)),readFile(new URL(item.id+'-study.bin',assets))]);
    assert.equal(image.readUInt16BE(0),0xffd8);
    const end=4+study.readUInt32LE(0);
    const h=JSON.parse(study.subarray(4,end));
    assert.equal(h.depthLabel,'Depth Anything V2 Small');
    assert.equal(h.visionLabel,'Tiny YOLOv3');
    assert.equal(study.length,end+h.gridW*h.gridH*6+h.featureShape.width*h.featureShape.height*h.featureShape.channels);
  }
});

test('a seed recreates eleven distinct captures and shuffling never edits the catalogue',()=>{
  const ids=entries.map(e=>e.id);
  const deck=shuffledAtlas(entries,'arcade11');
  assert.deepEqual(deck,shuffledAtlas(entries,'arcade11'));
  assert.notDeepEqual(deck,shuffledAtlas(entries,'historywalk'));
  assert.deepEqual(ids,entries.map(e=>e.id));
  assert.deepEqual(deck.map(e=>e.id).sort(),[...ids].sort());
  const walk=makeWalk(deck);
  assert.equal(walk.length,11);
  assert.equal(new Set(walk.map(e=>e.x+','+e.z)).size,11);
  assert.ok(new Set(walk.map(e=>e.yaw)).size>5);
});
