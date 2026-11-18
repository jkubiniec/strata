import test from 'node:test';
import assert from 'node:assert/strict';
import {withStorableMedia,readStore} from '../dist/interface.js';

test('WebKit stores that reject file objects restore the original photo and movie bytes',async()=>{
  const movie=new Blob(['frame data'],{type:'video/mp4'});
  const photo=new File(['picture'],'field.jpg',{type:'image/jpeg',lastModified:42});
  const original={id:1,file:photo,profile:{rgb:new Uint8Array([1,2,3]),imageBlob:photo,video:{blob:movie}}};
  let persisted,attempts=0;
  const db={transaction:()=>({objectStore:()=>({get:()=>{
    const req={result:persisted};queueMicrotask(()=>req.onsuccess());return req;
  }})})};
  await withStorableMedia(db,original,async value=>{
    attempts++;if(value.file instanceof File)throw new DOMException('BlobURLs are unsupported','DataCloneError');
    persisted=structuredClone(value);
  });
  assert.equal(attempts,2);
  const value=await readStore(db,'regions',1);
  assert.equal(await value.file.text(),'picture');
  assert.equal(value.file.lastModified,42);
  assert.equal(value.profile.imageBlob.name,'field.jpg');
  assert.equal(await value.profile.video.blob.text(),'frame data');
  assert.equal(value.profile.video.blob.type,'video/mp4');
  assert.deepEqual(value.profile.rgb,original.profile.rgb);
  assert.equal(original.profile.video.blob,movie);
  await withStorableMedia(db,original,async record=>assert.ok(record.file.bytes instanceof ArrayBuffer));
});
