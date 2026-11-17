import { Game } from './game.js';
import { cameraStamp } from './view-volume.js';
import { BLOCKS } from './world.js';
import { analyzeImage, detectObjects } from './vision.js';
import { icons, cubeIcon, depthImage, openDatabase, readStore, writeStore } from './interface.js';

import { describePose, heading, placementColor, placementMap } from './placements.js';
import { sampleProfile, refineryFeatures, sourceBlob } from './photo-assets.js';
import { WALK_STOPS, walkCapture, loadWalkProfile } from './walk-route.js';
import { PhotoBank } from './photo-bank.js';
import { prepareBankPreview, showBankPreview } from './bank-preview.js';

const $=id=>document.getElementById(id);
const requestedDemo=new URLSearchParams(location.search).get('demo');
const walkDemo=requestedDemo==='walk';
const completedWalk=walkDemo&&new URLSearchParams(location.search).get('complete')==='1';
const overlapStudy=completedWalk&&new URLSearchParams(location.search).get('overlap')==='arch';
const demo=walkDemo||requestedDemo==='views'||requestedDemo==='morph';
let walkOrigin,walkIndex=1,walkRetryAt=0;
const atlas=[], views=[], settings={mode:'hybrid',opacity:65,fov:65};
let game,db,library,ready=false,busy=false,playing=false,region=0,latestStats=null,selected=0,inspectedURL;
let pendingPlacement=null, visibleKey='', selectedViewId=null;
let noticeTimer,saveTimer,saveFailed=false;
const exampleBank=[], savedBankSources=new Set();
let bankOpen=false,bankPlacements=0,lastBankTime=0;
const bank=new PhotoBank(async file=>{
  const source=await prepareFile(file);
  prepareBankPreview(source.profile);
  return source;
},renderBank,()=>notice('Browser storage is unavailable for the bank. Photos can still be prepared for this session.'));
const pad=n=>String(n).padStart(2,'0');
const cap=s=>s.charAt(0).toUpperCase()+s.slice(1);
function notice(message){$('toast').textContent=message;$('toast').hidden=false;clearTimeout(noticeTimer);noticeTimer=setTimeout(()=>$('toast').hidden=true,4500);}
function syncSuspension(){game?.setSuspended(!ready||$('modal').open);}
function setLoading(message){
  if(ready){$('placement-label').textContent=message;$('placement-status').hidden=false;}
  else{$('load-label').textContent=message;$('load').hidden=false;}
}
function buttons(){
  for(const id of ['play','turn-left','turn-right'])$(id).disabled=!ready;
  for(const id of ['add-photo','path-action','replay-placement'])$(id).disabled=busy||!ready;
  renderBank();
}
function renderBank(){
  const items=bank.items.length?bank.items:exampleBank;
  let count=0,failed=0;
  for(const item of items){if(item.profile)count++;else if(item.failed)failed++;}
  const remaining=items.length-count-failed;
  const next=bank.next(exampleBank);
  $('bank-load').disabled=!bankOpen;
  $('bank-next').disabled=!ready||!next;
  $('bank-touch').hidden=!ready||!next;
  $('bank-count').textContent=count+' ready'+(remaining?' · '+remaining+' preparing':'')+(failed?' · '+failed+' unreadable':'');
  $('bank-upcoming').textContent=next?(!bank.items.length?'Sample · ':'Next · ')+next.name:
    remaining?'Preparing photos on this device…':'Load photos, then press B as you explore.';
  $('bank-thumb').hidden=!next;
  if(next&&$('bank-thumb').getAttribute('src')!==next.thumb)$('bank-thumb').src=next.thumb;
  if(!next)$('bank-thumb').removeAttribute('src');
  $('bank-pending').hidden=!bankPlacements;
  $('bank-pending').textContent=bankPlacements===1?'Blending one placement…':'Blending '+bankPlacements+' placements…';
}
function setSaved(text){$('save-status').lastChild.textContent=' '+text;}
function saveSettings(){
  if(!ready||!library||saveFailed)return;
  const state={...settings,selectedViewId,player:game.saveState()};
  writeStore(library,'settings',state,'session').catch(()=>{saveFailed=true;setSaved('Session only');notice('Browser storage is full or unavailable. This session is still playable.');});
}
function queueSave(){clearTimeout(saveTimer);saveTimer=setTimeout(saveSettings,220);}
async function persistRegion(record,replace=false){
  if(!db||saveFailed)return;
  try{await writeStore(db,'regions',record,undefined,!replace);setSaved('Saved locally');}
  catch{saveFailed=true;setSaved('Session only');notice('This region is playable for this session. Browser storage is full, unavailable, or was updated in another tab.');}
}
function selectedSlot(index){
  selected=index;document.querySelectorAll('.slot').forEach((slot,i)=>{slot.classList.toggle('selected',i===index);slot.setAttribute('aria-pressed',String(i===index));});
  $('current-block').textContent=BLOCKS[index]?.name||'';queueSave();
}
function renderHotbar(){
  BLOCKS.forEach((b,i)=>{const el=document.createElement('button');el.className='slot';el.title=(i+1)+' · '+b.name;el.setAttribute('aria-label',el.title);
    const num=document.createElement('kbd');num.textContent=i+1;el.append(num,cubeIcon(b));el.onclick=()=>game?.select(i);$('inventory').append(el);});selectedSlot(0);
}
function compass(heading){
  const deg=(heading%360+360)%360,card=['N','NE','E','SE','S','SW','W','NW'];
  const ticks=$('compass-tape'); const bucket=Math.round(deg/15);
  if(ticks.dataset.bucket!==String(bucket)){
    ticks.replaceChildren();ticks.dataset.bucket=bucket;
    for(let offset=-4;offset<=4;offset++){const mark=(bucket+offset)*15,s=document.createElement('span');
      s.className='compass-tick'+(mark%45?' minor':'');s.dataset.mark=mark;s.textContent=mark%45?'':card[((mark/45)%8+8)%8];ticks.append(s);}
  }
  for(const tick of ticks.children)tick.style.left=(50+(Number(tick.dataset.mark)-deg)*1.25)+'%';
  $('bearing').textContent=card[Math.round(deg/45)%8]+' · '+String(Math.round(deg)%360).padStart(3,'0')+'°';
}
function displayRegion(index){
  const r=views[index];if(!r)return;
  region=index;selectedViewId=r.id;
  const p=r.profile;
  $('source-index').textContent=pad(index+1)+' / '+pad(views.length);$('thumb').src=r.thumb;$('thumb').alt=r.title+' source photograph';
  $('filename').textContent=r.name;$('filetype').textContent=r.name.includes('.')?r.name.split('.').pop().slice(0,5).toUpperCase():'IMG';
  $('dimensions').textContent=p.width+' × '+p.height+' px';$('kind').textContent=cap(p.kind);
  $('view-heading').textContent=describePose(r.capture);
  $('palette').replaceChildren(...p.palette.map(color=>{const s=document.createElement('span');s.style.background=color;s.title=color;s.setAttribute('aria-label',color);return s;}));
}
function updateViewHUD(s){
  const indices=(s?.viewBlend?.indices||[]).filter(i=>views[i]);
  const key=indices.join(',')+'/'+views.length;
  if(visibleKey!==key){
    visibleKey=key;
    $('view-count').textContent=indices.length+' photo'+(indices.length===1?'':'s')+' in view';
    $('mix-meter').replaceChildren(...indices.map(i=>{const segment=document.createElement('span');segment.style.background=placementColor(i);return segment;}));
    $('mix-thumbs').replaceChildren(...indices.slice(-4).map(i=>{
      const img=document.createElement('img');img.src=views[i].thumb;img.alt='';img.style.borderColor=placementColor(i);return img;
    }));
    $('view-mix').title=indices.length?indices.map(i=>views[i].title).join(' · '):'Look toward a placed photo or add one here';
    $('region-no').textContent=indices.length>1?'OVERLAPPING VIEWS':indices.length?'CAPTURED VIEW':'WORLD';
  }
  const weights=s?.viewBlend?.weights||[];
  [...$('mix-meter').children].forEach((el,i)=>{const width=((weights[i]??0)*100).toFixed(1)+'%';if(el.style.width!==width)el.style.width=width;});
  const active=views[s?.viewBlend?.dominant]||views[indices[0]];
  const title=indices.length>1?'Blended landscape':active?.title||'Open landscape';
  if($('world-title').textContent!==title)$('world-title').textContent=title;
}
function onStats(s){
  latestStats=s;compass(s.heading);$('coords').textContent='X '+Math.floor(s.x)+'  Y '+Math.floor(s.y)+'  Z '+Math.floor(s.z);
  $('fps').textContent=playing?Math.round(s.fps)+' FPS':'WebGL 2';$('flight-status').textContent=s.flying?'Fly mode':'Walk mode';
  if(views.length)updateViewHUD(s);
  if(walkDemo&&ready)trackWalk(s);
}

function walkRecord(stop,profile) {
  return {id:'walk-'+stop.id,created:Date.now(),profile,title:stop.title,name:stop.image.split('/').pop(),
    thumb:stop.image,capture:walkCapture(game,stop,walkOrigin)};
}
function nextWalkIndex(){
  while(walkIndex<WALK_STOPS.length&&views.some(r=>r.id==='walk-'+WALK_STOPS[walkIndex].id))walkIndex++;
}
function trackWalk(s) {
  const button=$('walk-waypoint'),stop=WALK_STOPS[walkIndex];
  if(!stop||!walkOrigin){button.hidden=true;return;}
  const dx=walkOrigin.x+stop.x-s.x,dz=walkOrigin.z+stop.z-s.z,distance=Math.hypot(dx,dz);
  button.hidden=false;button.disabled=busy;
  const label=pad(walkIndex+1)+' / '+WALK_STOPS.length+' · '+stop.title+' · '+heading(Math.atan2(dx,-dz))+' · '+Math.ceil(distance)+' blocks';
  if(button.textContent!==label)button.textContent=label;
  if(playing&&!busy&&distance<=6&&Date.now()>walkRetryAt)placeWalkStop(false);
}
async function placeWalkStop(visit){
  const stop=WALK_STOPS[walkIndex];
  if(!stop||busy||!ready)return;
  busy=true;buttons();
  try{
    setLoading('Placing '+stop.title+'…');
    const record=walkRecord(stop,await loadWalkProfile(stop));
    const index=await installView(record,{animate:!visit,prepareReplay:true});
    nextWalkIndex();
    if(visit){game.goToStamp(index);game.replayPlacement();}
    displayRegion(index);updatePathAction();
    notice(stop.title+(walkIndex===WALK_STOPS.length?' · All 11 photos placed. Keep exploring.':' · Photo placed'));
    await persistView(record);saveSettings();
  }catch(error){
    walkRetryAt=Date.now()+8000;
    notice('Could not place '+stop.title+'. Select the waypoint to retry.');
    console.error(error);
  }finally{
    busy=false;buttons();$('placement-status').hidden=true;
    if(latestStats)trackWalk(latestStats);
  }
}
function playState(state){
  playing=state;document.body.classList.toggle('playing',state);if(state)$('inspector').classList.remove('open');if(!state)queueSave();
  $('connection').textContent=state?'Exploring':'World ready';
}
function applySettings(){
  game.setMode(settings.mode);game.setSplats(settings.opacity/100);game.setFov(settings.fov);
  for(const b of document.querySelectorAll('[data-mode]')){const chosen=b.dataset.mode===settings.mode;b.classList.toggle('selected',chosen);b.setAttribute('aria-pressed',String(chosen));}
  $('intensity').value=settings.opacity;$('intensity').style.setProperty('--p',settings.opacity+'%');$('intensity-out').textContent=settings.opacity+'%';$('intensity').disabled=settings.mode==='voxel';
}
function pop(kicker,title){
  game?.pause();$('modal-kicker').textContent=kicker;$('modal-title').textContent=title;$('modal-body').replaceChildren();
  if(!$('modal').open)$('modal').showModal();syncSuspension();return $('modal-body');
}
function closeModal(){if($('modal').open)$('modal').close();}
function inspectImage(which='photo'){
  const r=views[region];if(!r)return;const p=r.profile,body=pop('CAPTURE '+pad(region+1),'Source inspection');
  const switches=document.createElement('div');switches.className='segments analysis-tabs'; const frame=document.createElement('div');frame.className='inspect-image';
  frame.style.width='min(100%, '+(52*p.width/p.height)+'dvh)';frame.style.marginInline='auto';
  const summary=document.createElement('p');summary.className='insight';
  const draw=(tab)=>{
    for(const el of switches.children)el.classList.toggle('selected',el.dataset.tab===tab);
    frame.replaceChildren();const img=document.createElement('img');img.className='modal-image';img.alt=tab==='depth'?'Estimated relative depth':r.title;
    img.src=tab==='depth'?depthImage(p):r.thumb;
    // Keep detection coordinates registered to the uncropped photograph.
    img.style.maxHeight='none';frame.append(img);
    if(tab==='vision')for(const d of p.detections){
      const box=document.createElement('div');box.className='box-label';Object.assign(box.style,{left:d.x*100+'%',top:d.y*100+'%',width:d.w*100+'%',height:d.h*100+'%'});
      const label=document.createElement('span');label.textContent=d.label+' '+Math.round(d.score*100)+'%';box.append(label);frame.append(box);
    }
    if(tab==='photo'||tab==='vision'){
      if(p.imageBlob){inspectedURL ||= URL.createObjectURL(p.imageBlob);img.src=inspectedURL;}else img.src=p.imageURL || r.thumb;
    }
    if(tab==='photo')summary.textContent=r.name+' · '+p.width+' × '+p.height+' pixels';
    else if(tab==='vision')summary.textContent=(p.visionLabel||'Local scene analysis')+' · '+(p.detections.length?p.detections.length+' recognized object'+(p.detections.length===1?'':'s')+'.':'No object detections for this image.');
    else summary.textContent=(p.depthLabel||'Relative depth estimate')+' · Lighter surfaces are closer. The '+p.gridW+' × '+p.gridH+' sampling grid drives world generation.';
  };
  for(const [key,name] of [['photo','Photograph'],['vision','Detections'],['depth','Depth field']]){const b=document.createElement('button');b.textContent=name;b.dataset.tab=key;b.onclick=()=>draw(key);switches.append(b);}
  body.append(switches,frame,summary);draw(which);
}
function showControls(){
  const b=pop('FIELD GUIDE','Controls');
  const actions=[['Walk',['W','A','S','D']],['Look around',['Mouse','I','J','K','L']],['Jump / ascend in flight',['Space']],['Sprint',['Shift']],['Toggle flight',['F','2× Space']],['Descend in flight',['Q']],['Mine / place block',['Left / E','Right / R']],['Select material',['1–7','Wheel']],['Pick targeted block',['Middle click']],['Place next bank photo',['B']],['Choose one photo for this view',['U']],['Release mouse / pause',['Esc']]];
  const list=document.createElement('dl');list.className='key-list';
  for(const [name,keys] of actions){const dt=document.createElement('dt');dt.textContent=name;const dd=document.createElement('dd');keys.forEach(key=>{const k=document.createElement('kbd');k.textContent=key;dd.append(k,' ');});list.append(dt,dd);}
  b.append(list);const p=document.createElement('p');p.textContent='On a touch screen, drag to look and use the on-screen movement and building controls.';b.append(p);
  const label=document.createElement('label');label.className='range-label';label.htmlFor='fov';label.innerHTML='<span>Field of view</span><output></output>';
  const slider=document.createElement('input');slider.type='range';slider.min=45;slider.max=90;slider.id='fov';slider.value=settings.fov;
  const update=()=>{label.querySelector('output').textContent=slider.value+'°';slider.style.setProperty('--p',((slider.value-45)/45*100)+'%');};
  slider.oninput=()=>{settings.fov=+slider.value;game?.setFov(settings.fov);update();queueSave();};update();b.append(label,slider);
}
function showNotes(){
  const b=pop('WORLD GENERATION','Generation notes');
  b.innerHTML=`
    <h3>Reconstructing the photograph</h3>
    <p>Depth Anything V2 estimates how far each part of the image sits from the camera. The original colors are projected onto those surfaces. Near objects move farther across your view when you step sideways. Farther surfaces extend behind silhouettes to fill some of the newly exposed space.</p>
    <h3>Placing a photograph</h3>
    <p>A single upload captures your viewpoint when you open the picker. The photo bank prepares several images ahead of time. Each press of B places its next ready photo at that instant’s position, angle and field of view. Walk or turn between presses to change where the photographs overlap.</p>
    <h3>Blending shared space</h3>
    <p>Step toward a photo’s capture point and matching blocks and Gaussian splats shift toward its shapes and colors. Retrace your steps to reverse the change. Block faces stay aligned with the world axes, and blocks within building reach stay on the collision grid. Photo atlas recalls any saved viewpoint.</p>
    <h3>Exploring beyond the camera</h3>
    <p>The photograph supplies the visible appearance. Voxel terrain and scene-specific rules supply solid ground and plausible hidden faces. The inspector lets you isolate the voxels or splats and inspect the estimated depth. All photo analysis runs on this device.</p>
    <h3>Walkthrough photographs</h3>
    <p>The eleven-photo trail includes the refinery photograph, images from SpaceX and NASA, and eight public-domain National Park Service photographs. <a href="https://github.com/jkubiniec/strata#the-photo-atlas" target="_blank" rel="noreferrer">See the photographs and their credits</a>.</p>
    <h3>Research</h3>
    <p class="notes-source">Layered depth helps fill newly visible surfaces. <a href="https://www.robots.ox.ac.uk/~vgg/research/flash3d/" target="_blank" rel="noreferrer">Flash3D</a> · <a href="https://apple-aiml-research.github.io/ml-sharp/" target="_blank" rel="noreferrer">SHARP</a></p>
    <p class="notes-source">Anisotropic splats carry light and color. Cross-image feature matches guide the shape change. <a href="https://repo-sam.inria.fr/fungraph/3d-gaussian-splatting/" target="_blank" rel="noreferrer">3D Gaussian Splatting</a> · <a href="https://arxiv.org/abs/1705.01088" target="_blank" rel="noreferrer">Deep Image Analogy</a></p>`;
}
function showAtlas(){
  const b=pop('PHOTO ATLAS',views.length+' placed view'+(views.length===1?'':'s'));
  $('view-atlas').classList.add('active');$('view-world').classList.remove('active');
  const grid=document.createElement('div');grid.className='region-atlas';
  views.forEach((r,i)=>{
    const row=document.createElement('button');row.className='atlas-row';row.title='Return to the captured view for '+r.title;
    const img=document.createElement('img');img.src=r.thumb;img.alt='';
    const labels=document.createElement('div'),no=document.createElement('span'),name=document.createElement('strong'),pose=document.createElement('small');
    const seen=latestStats?.viewBlend, slot=seen?.indices?.indexOf(i)??-1;
    const share=slot<0?'':Math.max(1,Math.round(100*(seen.weights?.[slot]??0)))+'% in view';
    no.className='atlas-no';no.style.color=placementColor(i);no.textContent='VIEW '+pad(i+1)+' · '+heading(r.capture.yaw)+(share?' · '+share:'');
    name.textContent=r.title;pose.textContent=r.name+' · '+Math.round(180*r.capture.pitch/Math.PI)+'° pitch';labels.append(no,name,pose);
    const arr=document.createElement('i');arr.dataset.icon='forward';row.append(img,labels,arr);
    row.onclick=()=>{closeModal();game.goToStamp(i);displayRegion(i);saveSettings();};grid.append(row);
  });
  b.append(placementMap(views,game.captureView()),grid);
  const add=document.createElement('button');add.className='primary atlas-add';add.textContent='+  Add photo here';add.disabled=!ready||busy;add.onclick=requestPhoto;b.append(add);icons(b);
}
function requestPhoto(){
  if(busy||!ready)return;
  pendingPlacement={capture:game.captureView(),resume:playing};
  closeModal();game.pause();$('file').value='';$('file').click();
}
async function decodeImage(src){
  const img=new Image();img.decoding='async';img.src=src;await img.decode();return img;
}
function thumbnail(img){
  const scale=Math.min(1,720/Math.max(img.naturalWidth,img.naturalHeight)),cv=document.createElement('canvas');
  cv.width=Math.max(1,Math.round(img.naturalWidth*scale));cv.height=Math.max(1,Math.round(img.naturalHeight*scale));cv.getContext('2d').drawImage(img,0,0,cv.width,cv.height);return cv.toDataURL('image/jpeg',.84);
}
function nameRegion(name,kind){
  const stem=name.replace(/\.[^.]+$/,'').replace(/[_-]+/g,' ').trim();
  const defaults={industrial:'Industrial Yard',woodland:'Woodland',urban:'City Quarter',landscape:'Open Country',interior:'Interior',object:'Photo Garden'};
  return !stem||/^(img|cam|pxl|dsc|photo|image|screenshot|\d{3})/i.test(stem)?defaults[kind]||'Photo Region':stem.slice(0,55);
}
async function prepareFile(file,onProgress){
  const url=URL.createObjectURL(file);
  try{
    const img=await decodeImage(url),profile=await analyzeImage(img,{onProgress});
    profile.imageBlob=await sourceBlob(img);profile.featureVersion=1;
    return {name:file.name,title:nameRegion(file.name,profile.kind),thumb:thumbnail(img),profile};
  }finally{URL.revokeObjectURL(url);}
}
async function installView(record,options={}){
  const index=await game.addViewPhoto(record.profile,record.capture,options);
  views[index]=record;
  if(demo&&!record.bankSourceId&&(record.id==='region-0'||record.id==='launch'||record.id==='astronaut'||WALK_STOPS.some(stop=>record.id==='walk-'+stop.id))){
    exampleBank.push(record);
    prepareBankPreview(record.profile);renderBank();
  }
  return index;
}
async function persistView(record){
  if(!library||saveFailed)return;
  try{
    if(record.bankSourceId){
      const {bankSourceId,profile,thumb,...view}=record;
      // Each world owns its sources. Commit a new source and its pose together
      // so an interrupted placement cannot leave a view with dangling pixels.
      const tx=library.transaction(['settings','regions'],'readwrite');
      if(!savedBankSources.has(bankSourceId))tx.objectStore('settings').put({profile,thumb},'bank-source/'+bankSourceId);
      tx.objectStore('regions').put({...view,bankSourceId});
      await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});
      savedBankSources.add(bankSourceId);
    }else{await writeStore(library,'regions',record);}
    setSaved(demo?'Sample atlas':'Saved locally');
  }
  catch{saveFailed=true;setSaved('Session only');notice('This photo is playable for this session. Browser storage could not save it.');}
}
async function restoreBankViews(records){
  const sources=new Map();
  await Promise.all(records.map(async record=>{
    if(!record.bankSourceId||record.profile)return;
    const id=record.bankSourceId;
    if(!sources.has(id))sources.set(id,readStore(library,'settings','bank-source/'+id));
    const source=await sources.get(id);
    if(!source?.profile)throw Error('A saved bank photograph is missing.');
    Object.assign(record,source);
    savedBankSources.add(id);
  }));
}
async function placeBankPhoto(){
  if(!ready)return;
  const capture=game.captureView(),source=bank.take(exampleBank);
  if(!source){notice(bank.items.some(item=>item.file)?'The first bank photo is still preparing.':'Load photos in the Photo bank to use B.');return;}
  lastBankTime=Math.max(Date.now(),lastBankTime+1);
  const record={id:crypto.randomUUID(),created:lastBankTime,name:source.name,title:source.title,
    thumb:source.thumb,profile:source.profile,capture,bankSourceId:source.id};
  const preview=showBankPreview(game,source.profile,capture);
  bankPlacements++;renderBank();
  notice(source.title+' · '+heading(capture.yaw));
  // Save the pose before the expensive final merge. A reload can replay every
  // accepted tap, including placements whose geometry had still been queued.
  const journal=persistView(record);
  try{
    const index=await installView(record);preview.finish();
    displayRegion(index);updateViewHUD(latestStats);updatePathAction();saveSettings();
    await journal;
  }catch(error){
    preview.remove();console.error(error);await journal;
    if(library){
      const tx=library.transaction('regions','readwrite');
      tx.objectStore('regions').delete(record.id);
    }
    notice('Could not finish placing '+source.title+'.');
  }finally{bankPlacements--;renderBank();}
}
async function addFile(file,placement){
  if(!file||busy||!ready)return;
  const {capture,resume}=placement||{capture:game.captureView(),resume:playing};
  pendingPlacement=null;busy=true;buttons();syncSuspension();if(resume&&!playing)game.play();$('inspector').classList.remove('open');setLoading('Reading '+file.name+'…');
  let record;
  try{
    const source=await prepareFile(file,setLoading);
    const r={...source,id:crypto.randomUUID(),created:Date.now(),capture};
    setLoading('Placing photo at '+heading(capture.yaw)+'…');await new Promise(resolve=>setTimeout(resolve,0));
    const index=await installView(r);
    record=r;displayRegion(index);updateViewHUD(latestStats);updatePathAction();
    notice('Photo placed · '+heading(capture.yaw));
  }catch(e){console.error(e);notice(e.name==='EncodingError'?'This browser could not decode that image. Try exporting it as JPEG, PNG, or WebP.':'Could not place this photograph. '+(e.message||'Try a different image.'));}
  finally{$('placement-status').hidden=true;busy=false;syncSuspension();buttons();}
  if(record){const saved=persistView(record);saveSettings();await saved;}
}
function updatePathAction(){
  const btn=$('path-action');btn.querySelector('span').textContent=views.length>1?'View placements':'Try overlapping views';
  btn.title=views.length>1?'See captured camera positions and overlapping views':'Open a separate three-photo example';
  $('replay-placement').hidden=!game?.canReplayPlacement;
}
function wire(){
  icons();renderHotbar();compass(0);if(matchMedia('(pointer:coarse)').matches)document.querySelector('.entry-hint').textContent='Drag to aim · Tap + Photo to place';
  $('play').onclick=()=>game?.play();$('controls').onclick=showControls;$('notes').onclick=showNotes;$('view-atlas').onclick=showAtlas;$('view-world').onclick=()=>{closeModal();if(ready&&!busy)game.play();};
  $('enlarge').onclick=()=>inspectImage();$('vision-info').onclick=()=>inspectImage('vision');$('close-modal').onclick=closeModal;
  $('modal').addEventListener('click',e=>{if(e.target===$('modal')){const b=$('modal').getBoundingClientRect();if(e.clientX<b.left||e.clientX>b.right||e.clientY<b.top||e.clientY>b.bottom)closeModal();}});
  $('modal').onclose=()=>{if(inspectedURL){URL.revokeObjectURL(inspectedURL);inspectedURL=null;}syncSuspension();$('view-atlas').classList.remove('active');$('view-world').classList.add('active');};
  $('add-photo').onclick=requestPhoto;$('file').onchange=()=>addFile($('file').files[0],pendingPlacement);
  $('bank-load').onclick=()=>{game?.pause();$('bank-files').value='';$('bank-files').click();};
  $('bank-files').onchange=()=>{if($('bank-files').files.length)bank.add($('bank-files').files);};
  $('bank-next').onclick=placeBankPhoto;
  $('file').oncancel=()=>{const resume=pendingPlacement?.resume;pendingPlacement=null;if(resume)game.play();};
  $('mobile-inspector').onclick=()=>$('inspector').classList.add('open');$('inspector-close').onclick=()=>$('inspector').classList.remove('open');
  $('path-action').onclick=()=>{if(!ready||busy)return;if(views.length<2){location.href='./?demo=views';return;}$('inspector').classList.remove('open');showAtlas();};
  $('view-mix').onclick=()=>{if(ready&&!busy)showAtlas();};
  $('walk-waypoint').onclick=()=>placeWalkStop(true);
  $('replay-placement').onclick=()=>{if(ready&&!busy){game.replayPlacement();$('inspector').classList.remove('open');}};
  for(const [id,sign] of [['turn-left',-1],['turn-right',1]])$(id).onclick=()=>{if(ready){game.turnView(sign*Math.PI/12);saveSettings();}};
  $('fullscreen').onclick=async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await document.documentElement.requestFullscreen();}catch{notice('Fullscreen is unavailable in this browser view.');}};
  document.addEventListener('fullscreenchange',()=>$('fullscreen').setAttribute('aria-label',document.fullscreenElement?'Exit fullscreen':'Enter fullscreen'));
  for(const b of document.querySelectorAll('[data-mode]'))b.onclick=()=>{if(!game)return;settings.mode=b.dataset.mode;applySettings();queueSave();};
  $('intensity').oninput=()=>{settings.opacity=+$('intensity').value;if(game)applySettings();queueSave();};
  window.addEventListener('keydown',e=>{
    if(e.repeat||$('modal').open||e.ctrlKey||e.metaKey||e.altKey||e.target?.isContentEditable)return;
    if(e.code==='KeyB'){e.preventDefault();placeBankPhoto();}
    if(e.code==='KeyU'){e.preventDefault();requestPhoto();}
    if(e.code==='Escape')$('inspector').classList.remove('open');
  });
  for(const el of document.querySelectorAll('#touch-pad [data-key]')){el.onpointerdown=e=>{e.preventDefault();el.setPointerCapture(e.pointerId);game.moveKey(el.dataset.key,true);};el.onlostpointercapture=()=>game.moveKey(el.dataset.key,false);}
  for(const el of document.querySelectorAll('#touch-pad [data-act]'))el.onclick=()=>{
    if(el.dataset.act==='bank')placeBankPhoto();
    else if(el.dataset.act==='photo')requestPhoto();
    else if(el.dataset.act==='pause')game.pause();
    else game.interact(el.dataset.act==='place');
  };
  window.addEventListener('dragover',e=>e.preventDefault());window.addEventListener('drop',e=>{e.preventDefault();if(!ready||busy)return;if(e.dataTransfer.files.length!==1){notice('Choose one photograph for each region.');return;}const placement={capture:game.captureView(),resume:playing};closeModal();addFile(e.dataTransfer.files[0],placement);});
  document.addEventListener('visibilitychange',()=>{if(document.hidden)saveSettings();});window.addEventListener('pagehide',saveSettings);
}
async function start(){
  wire();busy=true;buttons();
  bank.open().then(()=>{
    const next=bank.next(exampleBank);
    if(next)prepareBankPreview(next.profile);
    bankOpen=true;renderBank();
  });
  try{
    game=new Game($('scene'),{onStats,onPlay:playState,onSelect:selectedSlot,onEdit:queueSave,onNotice:notice});syncSuspension();
    let records=[],saved=null,storedViews=[];
    try{
      const legacyDb=walkDemo?'strata-walk-base-v1':demo?(requestedDemo==='views'?'strata-view-example-base-v1':'strata-sample-world-v1'):undefined;
      const libraryName=walkDemo?(completedWalk?'strata-completed-walk-v2':'strata-photo-walk-v2'):demo?(requestedDemo==='views'?'strata-view-example-v1':'strata-view-migrated-example-v1'):'strata-directional-photos-v1';
      [db,library]=await Promise.all([openDatabase(legacyDb),openDatabase(libraryName)]);
      const [oldRegions,oldSession,photos,session]=await Promise.all([readStore(db,'regions'),readStore(db,'settings','session'),readStore(library,'regions'),readStore(library,'settings','session')]);
      records=oldRegions;storedViews=photos.sort((a,b)=>a.created-b.created||String(a.id).localeCompare(String(b.id)));saved=session||oldSession;
    }catch{setSaved('Session only');}
    if(records.length && !records[0].profile.depthLabel){
      const first=records[0];first.profile=await analyzeImage(await decodeImage('./assets/refinery.jpg'),{starter:true,onProgress:setLoading});await persistRegion(first,true);
    }
    if(!records.length){
      const img=await decodeImage('./assets/refinery.jpg');const profile=await analyzeImage(img,{starter:true,onProgress:setLoading});
      profile.imageURL='./assets/refinery.jpg';profile.featureVersion=1;
      const r={id:0,name:'CAM15071.JPG',title:'Refinery Yard',thumb:'./assets/refinery-preview.jpg',profile};
      setLoading('Building the refinery yard…');await new Promise(resolve=>setTimeout(resolve,0));r.anchor=await game.addRegion(profile);atlas.push(r);await persistRegion(r);
    }else{
      for(const r of records){
        setLoading('Restoring region '+pad(r.id+1)+'…');
        const p=r.profile;
        if(!p.imageBlob && !p.imageURL)p.imageURL=r.id===0?'./assets/refinery.jpg':r.thumb;
        if(!p.featureVersion){
          try{
            p.photoFeatures ||= r.id===0?await refineryFeatures():(await detectObjects(await decodeImage(r.thumb))).photoFeatures;
            p.featureVersion=1;await persistRegion(r,true);
          }catch{ /* RGB, depth and detection matches also work on legacy photos. */ }
        }
        await game.addRegion(p,r.anchor);atlas.push(r);
      }
      setSaved('Saved locally');
    }
    const legacyViews=atlas.map((r,i)=>{
      game.goTo(i);
      return {...r,id:'region-'+r.id,capture:game.captureView()};
    });
    game.goTo(0);
    for(const [i,r] of legacyViews.entries())await installView(r,{reference:i===0,animate:false});
    if(walkDemo)walkOrigin=legacyViews[0].capture;
    if(demo && !walkDemo && (requestedDemo==='views'||atlas.length===1)){
      const origin=legacyViews[0].capture;
      const samples=[['launch','Launch Pad','Falcon 9 launch.jpg',22],['astronaut','Astronaut','Eileen Collins.png',46]];
      for(const [name,title,file,offset] of samples){
        if(storedViews.some(r=>r.id===name))continue;
        setLoading('Placing '+title+'…');
        const profile=await sampleProfile(name);
        const record={id:name,created:offset,profile,title,name:file,thumb:profile.imageURL,capture:cameraStamp({eye:origin.eye,yaw:origin.yaw+offset*Math.PI/180,pitch:origin.pitch,fov:origin.fov,aspect:origin.aspect,near:origin.near,far:origin.far})};
        storedViews.push(record);await persistView(record);
      }
      storedViews.sort((a,b)=>a.created-b.created);
    }
    await restoreBankViews(storedViews);
    const newExample=requestedDemo==='views'&&!saved?.player&&storedViews.length===2;
    for(const r of storedViews){
      setLoading('Restoring '+r.title+'…');
      await installView(r,{prepareReplay:r===storedViews.at(-1),animate:newExample&&r.id==='astronaut'&&!matchMedia('(prefers-reduced-motion: reduce)').matches});
    }
    if(walkDemo){
      $('walk-link').hidden=true;
      nextWalkIndex();
      if(completedWalk)while(walkIndex<WALK_STOPS.length){
        const stop=WALK_STOPS[walkIndex];setLoading('Placing '+stop.title+' · '+(walkIndex+1)+' of '+WALK_STOPS.length+'…');
        const record=walkRecord(stop,await loadWalkProfile(stop));
        await installView(record,{animate:false,prepareReplay:walkIndex===WALK_STOPS.length-1});nextWalkIndex();
        await persistView(record);
      }
    }
    Object.assign(settings,{mode:saved?.mode||'hybrid',opacity:saved?.opacity??65,fov:saved?.fov||legacyViews[0].capture.fov});
    applySettings();
    if(saved?.player)game.restoreState(saved.player);
    else if(walkDemo)game.turnView(Math.atan2(WALK_STOPS[1].x,-WALK_STOPS[1].z));
    else if(demo && storedViews.some(r=>r.id==='launch'))game.turnView(22*Math.PI/180);
    let selectedIndex=views.findIndex(v=>v.id===saved?.selectedViewId);
    if(overlapStudy){
      selectedIndex=views.findIndex(v=>v.id==='walk-arch');
      if(selectedIndex>=0){
        game.goToStamp(selectedIndex);game.flying=false;
        game.turnView(49*Math.PI/180-game.yaw,Math.PI/180-game.pitch);
      }
    }
    displayRegion(selectedIndex>=0?selectedIndex:demo&&!walkDemo?Math.min(1,views.length-1):0);updateViewHUD(latestStats);
    ready=true;busy=false;syncSuspension();buttons();updatePathAction();$('load').hidden=true;$('connection').textContent='World ready';
    if(demo){$('demo-back').hidden=false;if(library&&!saveFailed)setSaved('Sample atlas');}
    if(walkDemo){
      document.querySelector('.entry-hint').textContent=walkIndex<WALK_STOPS.length?'Walk toward the next photo · Select its waypoint to jump there':'Explore 11 photos · Photo atlas recalls any viewpoint';
      if(overlapStudy)document.querySelector('.entry-hint').textContent='Walk forward into the overlap, then back to reverse the morph';
      if(latestStats)trackWalk(latestStats);
    }
  }catch(error){
    console.error(error);busy=false;$('connection').textContent='World unavailable';document.body.classList.add('world-error');
    setLoading(/WebGL|graphics context/i.test(error.message)?'Strata needs WebGL 2. Open this page in a hardware-accelerated browser.':'The world could not start. '+error.message);
    const retry=document.createElement('button');retry.className='primary';retry.textContent='Try again';retry.onclick=()=>location.reload();$('load-label').parentNode.append(retry);document.querySelector('.load-line').hidden=true;
  }
}
start();
