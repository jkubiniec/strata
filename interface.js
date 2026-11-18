const paths = {
  cube:'<path d="m12 2 9 5v10l-9 5-9-5V7zM3.5 7.4l8.5 5 8.5-5M12 12.4V22"/>',
  layers:'<path d="m12 3 9 5-9 5-9-5zM3 12l9 5 9-5M3 16l9 5 9-5"/>',
  keyboard:'<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M5 9h1m3 0h1m3 0h1m3 0h1M5 12h1m3 0h1m3 0h1m3 0h1M7 15h10"/>',
  expand:'<path d="M4 9V4h5m6 0h5v5m0 6v5h-5M9 20H4v-5"/>',
  sliders:'<path d="M3 7h6m4 0h8M3 17h10m4 0h4"/><circle cx="11" cy="7" r="2"/><circle cx="15" cy="17" r="2"/>',
  panel:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
  x:'<path d="m6 6 12 12M18 6 6 18"/>',
  image:'<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8" cy="8" r="1.5"/><path d="m4 18 6-6 4 3 3-4 4 4"/>',
  plus:'<path d="M12 4v16M4 12h16"/>',scan:'<path d="M3 8V4h5m8 0h5v4m0 8v4h-5m-8 0H3v-4M6 12h12"/>',
  'arrow-ne':'<path d="M6 18 18 6M6 6h12v12"/>',book:'<path d="M3 4h6a4 4 0 0 1 3 1.5A4 4 0 0 1 15 4h6v15h-6a4 4 0 0 0-3 1.5A4 4 0 0 0 9 19H3zM12 6v14"/>',
  pin:'<path d="M19 10c0 5-7 11-7 11s-7-6-7-11a7 7 0 1 1 14 0z"/><circle cx="12" cy="10" r="2"/>',
  drive:'<rect x="3" y="4" width="18" height="15" rx="2"/><path d="M3 14h18m-4 2.5h1"/>',
  play:'<path d="m6 3 14 9-14 9z" fill="currentColor" stroke="none"/>',
  route:'<circle cx="5" cy="18" r="2"/><path d="M7 18h8a3 3 0 0 0 0-6h-4a3 3 0 0 1 0-6h7m-3-3 3 3-3 3"/>',
  forward:'<path d="M5 12h14m-6-6 6 6-6 6"/>',
};
export function icons(root=document){
  for(const el of root.querySelectorAll('i[data-icon]')) el.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+(paths[el.dataset.icon]||'')+'</svg>';
}
export function cubeIcon(block){
  const canvas=document.createElement('canvas'); canvas.width=60;canvas.height=60;
  const ctx=canvas.getContext('2d'), hex=parseInt(block.color.slice(1),16);
  const top=[30,3],left=[3,17],right=[57,17],front=[30,32];
  const faces=[[top,[27,14],[-27,14],1.12],[left,[27,15],[0,26],.82],[front,[27,-15],[0,26],.61]];
  let seed=block.id*341;
  const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296};
  for(let side=0;side<faces.length;side++){
    const [origin,u,v,light]=faces[side];
    ctx.save();ctx.transform(u[0]/10,u[1]/10,v[0]/10,v[1]/10,...origin);
    for(let y=0;y<10;y++) for(let x=0;x<10;x++){
      const grain=random(), base=block.id===1 && side!==0 && y>(x%4?2:3)?0x8e6b4c:hex;
      let brightness=light*(.84+grain*.27);
      if(block.id===5 && (y===0||x===0))brightness*=.83;
      if(block.id===4 && (x%4===0||side===0 && y%5===0))brightness*=.78;
      if(block.id===7 && grain>.80)brightness*=.67;
      ctx.fillStyle='rgb('+[(base>>16)&255,(base>>8)&255,base&255].map(c=>Math.min(255,Math.round(c*brightness))).join(',')+')';
      ctx.fillRect(x,y,1.1,1.1);
    }ctx.restore();
  }return canvas;
}
export function depthImage(profile){
  const cv=document.createElement('canvas');cv.width=profile.gridW;cv.height=profile.gridH;
  const ctx=cv.getContext('2d'),image=ctx.createImageData(cv.width,cv.height);
  for(let i=0;i<profile.depth.length;i++){const d=profile.skyMask[i]?0:profile.depth[i];image.data.set([21+d*194,28+d*206,37+d*121,255],i*4);}
  ctx.putImageData(image,0,0);return cv.toDataURL('image/png');
}
export function openDatabase(name='strata-photo-worlds-v1'){
  return new Promise((resolve,reject)=>{
    const req=indexedDB.open(name,1);
    req.onupgradeneeded=()=>{const db=req.result;db.createObjectStore('regions',{keyPath:'id'});db.createObjectStore('settings');};
    req.onerror=()=>reject(req.error);req.onsuccess=()=>resolve(req.result);req.onblocked=()=>reject(new Error('Another tab is updating the photo atlas.'));
  });
}
// Some WebKit storage contexts can store ArrayBuffers but reject Blob and File.
// Retry those records in a portable representation and revive them on reads.
const bufferDatabases=new WeakMap();
const binaryKeys=['file','imageBlob','blob'];
function mapMedia(record,convert){
  if(!record||typeof record!=='object')return record;
  let result=record;
  for(const key of [...binaryKeys,'profile','video']){
    if(!record[key])continue;
    const value=binaryKeys.includes(key)?convert(record[key]):mapMedia(record[key],convert);
    if(value!==record[key]){if(result===record)result={...record};result[key]=value;}
  }
  return result;
}
async function packMedia(record){
  const pending=[];
  const result=mapMedia(record,blob=>{
    if(!(blob instanceof Blob))return blob;
    const wrapped={strataBinary:1,type:blob.type,name:blob.name,lastModified:blob.lastModified};
    pending.push(blob.arrayBuffer().then(bytes=>{wrapped.bytes=bytes;}));return wrapped;
  });
  await Promise.all(pending);return result;
}
function reviveMedia(record){
  return mapMedia(record,value=>{
    if(value.strataBinary!==1)return value;
    return typeof value.name==='string'?new File([value.bytes],value.name,{type:value.type,lastModified:value.lastModified}):
      new Blob([value.bytes],{type:value.type});
  });
}
export async function withStorableMedia(db,record,write){
  if(!bufferDatabases.has(db)){
    try{return await write(record);}catch(error){
      if(error?.name!=='DataCloneError')throw error;
      if(!bufferDatabases.has(db))bufferDatabases.set(db,Promise.resolve());
    }
  }
  // Keep a large multi-select within the phone’s memory budget.
  const pending=bufferDatabases.get(db).then(async()=>write(await packMedia(record)));
  bufferDatabases.set(db,pending.catch(()=>{}));
  return pending;
}
export function readStore(db,name,key){
  return new Promise((resolve,reject)=>{
    const store=db.transaction(name).objectStore(name),req=key===undefined?store.getAll():store.get(key);
    req.onsuccess=()=>{try{resolve(key===undefined?req.result.map(reviveMedia):reviveMedia(req.result));}catch(e){reject(e);}};
    req.onerror=()=>reject(req.error);
  });
}
export function writeStore(db,name,item,key,insert=false){
  return withStorableMedia(db,item,record=>new Promise((resolve,reject)=>{
    const tx=db.transaction(name,'readwrite'),store=tx.objectStore(name);
    tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error);
    try{if(insert)store.add(record,key);else store.put(record,key);}
    catch(error){tx.abort();reject(error);}
  }));
}

export function atlasMap(records,position){
  const cv=document.createElement('canvas');cv.className='atlas-map';cv.width=920;cv.height=310;
  cv.setAttribute('role','img');cv.setAttribute('aria-label','Plan view of photo regions and player position, north up');
  const ctx=cv.getContext('2d');ctx.scale(2,2);
  const w=460,h=155,points=records.map(r=>r.anchor);
  if(!points.length)return cv;
  if(position)points.push(position);
  let minX=Infinity,minZ=Infinity,maxX=-Infinity,maxZ=-Infinity;
  for(const p of points){minX=Math.min(minX,p.x);maxX=Math.max(maxX,p.x);minZ=Math.min(minZ,p.z);maxZ=Math.max(maxZ,p.z);}
  const scale=Math.min((w-88)/Math.max(75,maxX-minX),(h-45)/Math.max(65,maxZ-minZ));
  const ox=w/2-(minX+maxX)*scale/2,oy=h/2-(minZ+maxZ)*scale/2;
  const project=p=>[ox+p.x*scale,oy+p.z*scale];
  ctx.fillStyle='#182018';ctx.fillRect(0,0,w,h);ctx.lineWidth=.5;ctx.strokeStyle='#343e30';
  const increment=2**Math.round(Math.log2(28/scale)),spacing=scale*increment;
  ctx.beginPath();
  for(let x=(ox%spacing+spacing)%spacing;x<w;x+=spacing){ctx.moveTo(x,0);ctx.lineTo(x,h);}
  for(let y=(oy%spacing+spacing)%spacing;y<h;y+=spacing){ctx.moveTo(0,y);ctx.lineTo(w,y);}
  ctx.stroke();ctx.strokeStyle='#8e9e76';ctx.lineWidth=1;ctx.setLineDash([3,3]);ctx.beginPath();
  records.forEach((r,i)=>{const [x,y]=project(r.anchor);if(i)ctx.lineTo(x,y);else ctx.moveTo(x,y);});
  ctx.stroke();ctx.setLineDash([]);ctx.font='9px monospace';
  records.forEach(r=>{const [x,y]=project(r.anchor),a=r.anchor;
    ctx.fillStyle='#50634277';ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(x+19*a.dx-10*a.dz,y+19*a.dz+10*a.dx);ctx.lineTo(x+19*a.dx+10*a.dz,y+19*a.dz-10*a.dx);ctx.fill();
    ctx.fillStyle='#b3c49e';ctx.strokeStyle='#182018';ctx.lineWidth=1.5;ctx.fillRect(x-3,y-3,6,6);ctx.strokeRect(x-3,y-3,6,6);
    ctx.fillStyle='#d5dfcb';ctx.fillText(String(r.id+1).padStart(2,'0'),x+7,y-6);
  });
  if(position){const [x,y]=project(position);ctx.strokeStyle='#d2f77c';ctx.lineWidth=1;ctx.beginPath();ctx.arc(x,y,6,0,Math.PI*2);ctx.stroke();ctx.fillStyle='#d2f77c';ctx.beginPath();ctx.arc(x,y,2.2,0,Math.PI*2);ctx.fill();}
  ctx.fillStyle='#afbaa6';ctx.fillText('↑ N',10,16);ctx.fillText(increment+' blocks / grid',10,h-9);return cv;
}
