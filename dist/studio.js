import { Game } from './game.js';
import { cameraStamp } from './view-volume.js';
import { BLOCKS } from './world.js';
import { analyzeImage, detectObjects } from './vision.js';
import { icons, cubeIcon, depthImage, openDatabase, readStore, writeStore, withStorableMedia } from './interface.js';

import { describePose, heading, placementColor, mountPlacementMap } from './placements.js';
import { expressProfile, importPixels, sourceBlob } from './photo-assets.js';
import { isVideoFile, prepareVideo } from './video-source.js';
import {loadHistory} from './history-atlas.js';
import { isMobileRenderer } from './performance-profile.js';
import { makeWalk, walkCapture, loadWalkProfile } from './walk-route.js';
import { PhotoBank, WalkingPlacement, sameAutoView } from './photo-bank.js';
import { prepareBankPreview, showBankPreview } from './bank-preview.js';
import { bindTouchPad } from './touch-pad.js';

const $=id=>document.getElementById(id);
const params=new URLSearchParams(location.search);
const demo=params.get('world')!=='mine';
const requestedDemo=demo?(params.get('demo')||'computer'):null;
const walkDemo=requestedDemo==='walk';
const autoDemo=['autowalk','computer','phone'].includes(requestedDemo);
const videoDemo=requestedDemo==='video';
const filmFlight=requestedDemo==='flight';
const completedWalk=walkDemo&&params.get('complete')==='1';
const overlapStudy=completedWalk&&!!params.get('overlap');
const seed=params.get('seed')||crypto.getRandomValues(new Uint32Array(1))[0].toString(36);
let historyDeck=[],walkStops=[],warming=false,archiveOffered=false;
let walkOrigin,walkIndex=1,walkRetryAt=0,walkAutomatic=true;
const atlas=[], views=[], settings={mode:'hybrid',opacity:65,fov:65};
let game,db,library,ready=false,busy=false,playing=false,region=0,latestStats=null,selected=0,inspectedURL;
let pendingPlacement=null, visibleKey='', selectedViewId=null;
let noticeTimer,saveTimer,saveFailed=false,clearTouchPad,disposeMap;
const clipViews=new Map();
let controlClip=null;
const exampleBank=[], savedBankSources=new Set();
let bankOpen=false,bankPlacements=0,lastBankTime=0;
let sampleAutomatic=autoDemo||new URLSearchParams(location.search).get('auto')==='1',warmProfile,autoAfterPicker=false;
const walkingPlacement=new WalkingPlacement();
const bank=new PhotoBank(file=>prepareFile(file),renderBank,()=>notice('Browser storage is unavailable for the bank. Photos can still be prepared for this session.'));
const pad=n=>String(n).padStart(2,'0');
const cap=s=>s.charAt(0).toUpperCase()+s.slice(1);
function notice(message){$('toast').textContent=message;$('toast').hidden=false;clearTimeout(noticeTimer);noticeTimer=setTimeout(()=>$('toast').hidden=true,4500);}
function syncSuspension(){game?.setSuspended(!ready||$('modal').open);}
function setLoading(message){
  if(ready){$('placement-label').textContent=message;$('placement-status').hidden=false;}
  else{$('load-label').textContent=message;$('load').hidden=false;}
}
function buttons(){
  for(const id of ['play','turn-left','turn-right','view-atlas'])$(id).disabled=!ready;
  for(const id of ['add-photo','path-action','replay-placement'])$(id).disabled=busy||!ready;
  renderBank();
}
function renderBank(){
  const items=bank.items.length?bank.items:exampleBank;
  if(archiveOffered&&!warming)void warmArchive();
  let count=0,failed=0;
  for(const item of items){if(item.profile)count++;else if(item.failed)failed++;}
  const remaining=items.length-count-failed;
  const next=bank.next(exampleBank);
  $('bank-load').disabled=!bankOpen;
  $('bank-entry').disabled=!bankOpen||!ready;
  $('bank-next').disabled=!ready||!next;
  $('bank-touch').hidden=!ready||!next;
  const automatic=automaticEnabled();
  $('bank-auto').disabled=!items.length;
  $('bank-auto').checked=!!items.length&&automatic;
  $('auto-hud').hidden=!items.length;
  $('auto-hud').setAttribute('aria-pressed',String(automatic));
  $('auto-mode').textContent=automatic?'Stop cycling':'Start cycling';
  $('auto-hud').setAttribute('aria-label',$('auto-mode').textContent+' photos and videos');
  $('auto-ready').textContent=archiveOffered?historyDeck.length+' in atlas':count+' / '+items.length+' ready';
  $('bank-count').textContent=(archiveOffered?count+' ready · '+historyDeck.length+' in atlas':count+' ready'+(remaining?' · '+remaining+' preparing':''))+(failed?' · '+failed+' unreadable':'');
  $('bank-upcoming').textContent=next?(!bank.items.length?'Sample · ':'Next · ')+next.name:
    remaining?'Preparing media on this device…':'Select photos and videos together.';
  $('bank-thumb').hidden=!next;
  if(next&&$('bank-thumb').getAttribute('src')!==next.thumb)$('bank-thumb').src=next.thumb;
  if(!next)$('bank-thumb').removeAttribute('src');
  $('bank-pending').hidden=!bankPlacements;
  $('bank-pending').textContent=bankPlacements===1?'Blending one placement…':'Blending '+bankPlacements+' placements…';
  if(next?.profile&&next.profile!==warmProfile){
    const profile=warmProfile=next.profile;
    setTimeout(()=>{if(warmProfile===profile)prepareBankPreview(profile);},0);
  }
}
function movementPose(){
  const {x,y,z}=game.position;
  return {x,y,z,yaw:game.yaw,pitch:game.pitch};
}
function guidedWalk(){return walkDemo&&!completedWalk&&!bank.items.length&&walkIndex<walkStops.length;}
function automaticEnabled(){return bank.items.length?bank.automatic:guidedWalk()?walkAutomatic:sampleAutomatic;}
function setAutomatic(enabled){
  if(game)walkingPlacement.reset(movementPose());
  if(bank.items.length)bank.setAutomatic(enabled);
  else{if(guidedWalk())walkAutomatic=enabled;else sampleAutomatic=enabled;renderBank();queueSave();}
}
function trackBank(){
  if(!playing||document.hidden||guidedWalk()||!automaticEnabled())return;
  const available=!busy&&!bankPlacements&&!game.viewAtlas.animating&&!!bank.next(exampleBank);
  if(walkingPlacement.update(movementPose(),performance.now(),available))placeBankPhoto(true);
}
function setSaved(text){$('save-status').lastChild.textContent=' '+text;}
function saveSettings(){
  if(!ready||!library||saveFailed)return;
  const clipTimes={};
  for(const id of clipViews.keys())clipTimes[id]=game.videoField.time(id);
  const preferredViewId=views[game.viewAtlas.preferredCapture]?.id;
  const state={...settings,selectedViewId,preferredViewId,sampleAutomatic,walkAutomatic,clipTimes,clipsPlaying:game.videoField.playing,player:game.saveState()};
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
  $('source-index').textContent=pad(index+1)+' / '+pad(views.length);$('thumb').src=r.thumb;$('thumb').alt=r.title+(p.video?' video frame':' source photograph');
  $('filename').textContent=r.name;$('filetype').textContent=r.name.includes('.')?r.name.split('.').pop().slice(0,5).toUpperCase():'IMG';
  $('dimensions').textContent=p.width+' × '+p.height+' px';$('kind').textContent=cap(p.kind);
  $('view-heading').textContent=describePose(r.capture);
  $('palette').replaceChildren(...p.palette.map(color=>{const s=document.createElement('span');s.style.background=color;s.title=color;s.setAttribute('aria-label',color);return s;}));
  drawClipControls();
}
function clipTime(seconds){
  const whole=Math.max(0,Math.floor(seconds||0));
  return Math.floor(whole/60)+':'+String(whole%60).padStart(2,'0');
}
function drawClipControls(){
  if(!clipViews.size)return;
  const dominant=views[latestStats?.viewBlend?.dominant];
  const record=views[region]?.profile.video?views[region]:dominant?.profile.video?dominant:clipViews.values().next().value;
  const clip=record.profile.video,field=game.videoField;
  if(controlClip?.id!==clip.id){
    controlClip=clip;
    $('clip-name').textContent=record.title;
    $('clip-position').max=clip.duration;
  }
  $('clip-panel').hidden=$('clip-hud').hidden=false;
  const action=field.playing?'Pause video':'Play video';
  if($('clip-toggle').textContent!==action)$('clip-hud').textContent=$('clip-toggle').textContent=action;
  const time=field.time(clip.id);
  $('clip-clock').textContent=clipTime(time)+' / '+clipTime(clip.duration);
  if(!$('clip-position').matches(':active'))$('clip-position').value=time;
}
function toggleClips(){
  if(!game||!clipViews.size)return;
  game.videoField.setPlaying(!game.videoField.playing);
  game.drawRequested=true;drawClipControls();queueSave();
}
function updateViewHUD(s){
  const indices=(s?.viewBlend?.indices||[]).filter(i=>views[i]);
  const preferred=game?.viewAtlas.preferredCapture, capture=views[preferred]?.capture;
  const eye=game?.camera.position;
  const recalled=capture&&game.recalledAspect===capture.aspect&&Math.abs(game.yaw-capture.yaw)<.00001&&
    Math.abs(game.pitch-capture.pitch)<.00001&&Math.hypot(eye.x-capture.eye.x,eye.y-capture.eye.y,eye.z-capture.eye.z)<.001;
  const key=indices.join(',')+'/'+views.length+'/'+(recalled?preferred:'');
  if(visibleKey!==key){
    visibleKey=key;
    const media=indices.some(i=>views[i].profile.video);
    $('view-count').textContent=indices.length+(media?(indices.length===1?' video':' sources'):indices.length===1?' photo':' photos')+' in view';
    $('mix-meter').replaceChildren(...indices.map(i=>{const segment=document.createElement('span');segment.style.background=placementColor(i);return segment;}));
    $('mix-thumbs').replaceChildren(...indices.slice(-4).map(i=>{
      const img=document.createElement('img');img.src=views[i].thumb;img.alt='';img.style.borderColor=placementColor(i);return img;
    }));
    $('view-mix').title=indices.length?indices.map(i=>views[i].title).join(' · '):'Look toward a placed photo or add one here';
    $('region-no').textContent=recalled?'ORIGINAL VIEW':indices.length>1?'OVERLAPPING VIEWS':indices.length?'CAPTURED VIEW':'WORLD';
  }
  const weights=s?.viewBlend?.weights||[];
  [...$('mix-meter').children].forEach((el,i)=>{const width=((weights[i]??0)*100).toFixed(1)+'%';if(el.style.width!==width)el.style.width=width;});
  const active=views[s?.viewBlend?.dominant]||views[indices[0]];
  const title=recalled?views[preferred].title:indices.length>1?'Blended landscape':active?.title||'Open landscape';
  if($('world-title').textContent!==title)$('world-title').textContent=title;
}
function onStats(s){
  latestStats=s;compass(s.heading);$('coords').textContent='X '+Math.floor(s.x)+'  Y '+Math.floor(s.y)+'  Z '+Math.floor(s.z);
  $('fps').textContent=playing?Math.round(s.fps)+' FPS':'WebGL 2';$('flight-status').textContent=s.flying?'Fly mode':'Walk mode';
  if(views.length)updateViewHUD(s);
  drawClipControls();
  if(walkDemo&&ready)trackWalk(s);
  if(ready)trackBank();
}

function walkRecord(stop,profile) {
  return {id:'walk-'+stop.id,created:Date.now(),historyId:stop.id,profile,title:stop.title,name:stop.title,
    thumb:stop.image,capture:walkCapture(game,stop,walkOrigin)};
}
function offerArchive(){
  const base=exampleBank[0];
  const items=(videoDemo?historyDeck:[...historyDeck.slice(1),historyDeck[0]]).map(stop=>({id:'walk-'+stop.id,name:stop.title,title:stop.title,thumb:stop.image,stop}));
  const placed=new Map(views.map(r=>[r.historyId||String(r.id).replace(/^walk-/,''),r.profile]));
  for(const item of items)item.profile=placed.get(item.stop.id);
  if(videoDemo&&base)items.push(base);
  exampleBank.splice(0,exampleBank.length,...items);archiveOffered=true;
  renderBank();
}
async function warmArchive(){
  if(!archiveOffered||warming||!demo)return;
  warming=true;
  try{
    const cursor=exampleBank.findIndex(r=>r.id===bank.lastId);
    for(let i=1;i<=Math.min(3,exampleBank.length);i++){
      const item=exampleBank[(cursor+i)%exampleBank.length];
      if(item.profile||item.failed||!item.stop)continue;
      try{item.profile=await loadWalkProfile(item.stop);}catch{item.failed=true;}
      renderBank();
    }
  }finally{warming=false;}
  // The player may have placed another item during a fetch.
  const cursor=exampleBank.findIndex(r=>r.id===bank.lastId);
  if([1,2,3].some(i=>{const r=exampleBank[(cursor+i)%exampleBank.length];return r?.stop&&!r.profile&&!r.failed;}))warmArchive();
}
function nextWalkIndex(){
  while(walkIndex<walkStops.length&&views.some(r=>r.id==='walk-'+walkStops[walkIndex].id))walkIndex++;
}
function trackWalk(s) {
  const button=$('walk-waypoint'),stop=walkStops[walkIndex];
  if(!stop||!walkOrigin){button.hidden=true;return;}
  const dx=walkOrigin.x+stop.x-s.x,dz=walkOrigin.z+stop.z-s.z,distance=Math.hypot(dx,dz);
  button.hidden=false;button.disabled=busy;
  const label=pad(walkIndex+1)+' / '+walkStops.length+' · '+stop.title+' · '+heading(Math.atan2(dx,-dz))+' · '+Math.ceil(distance)+' blocks';
  if(button.textContent!==label)button.textContent=label;
  if(playing&&guidedWalk()&&walkAutomatic&&!busy&&distance<=6&&Date.now()>walkRetryAt)placeWalkStop(false);
}
async function placeWalkStop(visit){
  const stop=walkStops[walkIndex];
  if(!stop||busy||!ready)return;
  busy=true;buttons();
  try{
    setLoading('Placing '+stop.title+'…');
    const record=walkRecord(stop,await loadWalkProfile(stop));
    const index=await installView(record,{animate:!visit,prepareReplay:true});
    nextWalkIndex();
    if(visit){game.goToStamp(index);game.replayPlacement();}
    displayRegion(index);updatePathAction();
    notice(stop.title+(walkIndex===walkStops.length?' · All 11 photos placed. Keep exploring.':' · Photo placed'));
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
  if(state)walkingPlacement.reset(movementPose());
  else clearTouchPad?.();
  playing=state;document.body.classList.toggle('playing',state);if(state)$('inspector').classList.remove('open');if(!state)queueSave();
  $('connection').textContent=state?'Exploring':'World ready';
}
function applySettings(){
  game.setMode(settings.mode);game.setSplats(settings.opacity/100);game.setFov(settings.fov);
  for(const b of document.querySelectorAll('[data-mode]')){const chosen=b.dataset.mode===settings.mode;b.classList.toggle('selected',chosen);b.setAttribute('aria-pressed',String(chosen));}
  $('intensity').value=settings.opacity;$('intensity').style.setProperty('--p',settings.opacity+'%');$('intensity-out').textContent=settings.opacity+'%';$('intensity').disabled=settings.mode==='voxel';
}
function pop(kicker,title){
  disposeMap?.();disposeMap=null;
  game?.pause();$('modal-kicker').textContent=kicker;$('modal-title').textContent=title;$('modal-body').replaceChildren();
  if(!$('modal').open)$('modal').showModal();syncSuspension();return $('modal-body');
}
function showHistory(){
  if(!historyDeck.length)return;
  const body=pop('HISTORICAL ATLAS',historyDeck.length+' historical images');
  const collection=document.createElement('div');collection.className='history-grid';
  for(const item of historyDeck){
    const card=document.createElement('article');card.className='history-card';
    const image=document.createElement('img');image.loading='lazy';image.decoding='async';image.src=item.image;image.alt=item.title;
    const title=document.createElement('h3');title.textContent=item.title;
    const date=document.createElement('small');date.textContent=item.year+' · '+item.credit;
    const caption=document.createElement('p');caption.textContent=item.description;
    const source=document.createElement('a');source.href=item.source;source.target='_blank';source.rel='noreferrer';source.textContent='Collection record ↗';
    const rights=document.createElement('small');rights.textContent=item.rights;
    card.append(image,title,date,caption,source,rights);collection.append(card);
  }
  body.append(collection);
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
  const actions=[['Walk',['W','A','S','D']],['Look around',['Mouse','I','J','K','L']],['Jump / ascend in flight',['Space']],['Sprint',['Shift']],['Toggle flight',['F','2× Space']],['Open placement sitemap',['M']],['Descend in flight',['Q']],['Mine / place block',['Left / E','Right / R']],['Select material',['1–7','Wheel']],['Pick targeted block',['Middle click']],['Place next bank item',['B']],['Start / stop cycling',['G']],['Choose a photo or video',['U']],['Release mouse / pause',['Esc']]];
  const list=document.createElement('dl');list.className='key-list';
  for(const [name,keys] of actions){const dt=document.createElement('dt');dt.textContent=name;const dd=document.createElement('dd');keys.forEach(key=>{const k=document.createElement('kbd');k.textContent=key;dd.append(k,' ');});list.append(dt,dd);}
  b.append(list);const p=document.createElement('p');p.textContent='On a phone, tap Import & walk to choose photos and videos together. Hold or slide across the arrows to walk. Tap Stop cycling to explore, or Start cycling to place more media. Pause video controls film playback separately.';b.append(p);
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
    <h3>Placing photos and video</h3>
    <p>The media bank prepares your selection on this device. Walk 12 blocks or turn 35° to place the next ready item in the direction you are facing. Start cycling and Stop cycling control that rotation. A placed video has its own clock. Its moving depth field shifts blocks and splats, even when you stand still. Use Video playback to pause or scrub it.</p>
    <h3>Blending shared space</h3>
    <p>Step toward a photo’s capture point and matching blocks and Gaussian splats shift toward its shapes and colors. Retrace your steps to reverse the change. Block faces stay aligned with the world axes, and blocks within building reach stay on the collision grid. Use the sitemap to return to any saved viewpoint.</p>
    <h3>Exploring beyond the camera</h3>
    <p>The photograph supplies the visible appearance. Voxel terrain and scene-specific rules supply solid ground and plausible hidden faces. The inspector lets you isolate the voxels or splats and inspect the estimated depth. All photo analysis runs on this device.</p>
    <h3>Walkthrough photographs</h3>
    <p>Each public walk draws from a shuffled historical atlas. Open Historical atlas to see dates, captions, rights information and links to the original collections. Personal media lives in the separate My media world.</p>
    <h3>Research</h3>
    <p class="notes-source">Layered depth helps fill newly visible surfaces. <a href="https://www.robots.ox.ac.uk/~vgg/research/flash3d/" target="_blank" rel="noreferrer">Flash3D</a> · <a href="https://apple-aiml-research.github.io/ml-sharp/" target="_blank" rel="noreferrer">SHARP</a></p>
    <p class="notes-source">Anisotropic splats carry light and color. Cross-image feature matches guide the shape change. <a href="https://repo-sam.inria.fr/fungraph/3d-gaussian-splatting/" target="_blank" rel="noreferrer">3D Gaussian Splatting</a> · <a href="https://arxiv.org/abs/1705.01088" target="_blank" rel="noreferrer">Deep Image Analogy</a></p>`;
}
function showAtlas(){
  if(!ready||!game)return;
  const b=pop('WORLD NAVIGATION','Placement sitemap');
  $('view-atlas').classList.add('active');$('view-world').classList.remove('active');
  const records=views.slice(),all=records.map((_,i)=>i);
  const map=document.createElement('div'),grid=document.createElement('div');grid.className='region-atlas';
  const hint=document.createElement('p');hint.className='map-instructions';
  hint.textContent='Select a pin to return to its camera. Pins marked × contain several views.';
  const toolbar=document.createElement('div');toolbar.className='map-search';
  const search=document.createElement('input');search.type='search';search.placeholder='Find a placement';
  search.setAttribute('aria-label','Find a placement by title, file name or view number');
  const reset=document.createElement('button');reset.type='button';reset.textContent='All placements';reset.hidden=true;
  const status=document.createElement('p');status.className='map-count';status.setAttribute('role','status');
  toolbar.append(search,reset);b.append(hint,map,toolbar,status,grid);
  function visit(i){
    closeModal();game.goToStamp(i);displayRegion(i);saveSettings();
  }
  function rowFor(i){
    const r=records[i],row=document.createElement('button');row.type='button';row.className='atlas-row';row.title='Return to '+r.title;
    const img=document.createElement('img');img.loading='lazy';img.decoding='async';img.src=r.thumb;img.alt='';
    const labels=document.createElement('div'),no=document.createElement('span'),name=document.createElement('strong'),pose=document.createElement('small');
    const seen=latestStats?.viewBlend,slot=seen?.indices?.indexOf(i)??-1;
    const share=slot<0?'':' · '+Math.max(1,Math.round(100*(seen.weights?.[slot]??0)))+'% in view';
    no.className='atlas-no';no.style.color=placementColor(i);
    no.textContent='VIEW '+pad(i+1)+' · '+(r.profile.video?'VIDEO':'PHOTO')+share;
    const {x,y,z}=r.capture.eye;
    name.textContent=r.title;pose.textContent=describePose(r.capture)+' · XYZ '+[x,y,z].map(v=>Math.round(v*10)/10).join(' / ');
    labels.append(no,name,pose);
    const arr=document.createElement('span');arr.className='map-row-arrow';arr.setAttribute('aria-hidden','true');arr.textContent='→';
    row.append(img,labels,arr);row.onclick=()=>visit(i);return row;
  }
  let subset=all,matches=[],shown=0;
  const more=document.createElement('button');more.type='button';more.className='sample-path';more.textContent='Show more placements';
  function appendRows(){
    const next=matches.slice(shown,shown+40);grid.append(...next.map(rowFor));shown+=next.length;
    more.hidden=shown>=matches.length;
  }
  function filter(){
    const term=search.value.trim().toLowerCase();
    matches=subset.filter(i=>!term || [String(i+1),pad(i+1)].includes(term) || (records[i].title+' '+records[i].name).toLowerCase().includes(term));
    status.textContent=matches.length+' placement'+(matches.length===1?'':'s')+(subset===all?'':' at this spot');
    grid.replaceChildren();shown=0;appendRows();
  }
  search.oninput=filter;more.onclick=appendRows;
  reset.onclick=()=>{subset=all;reset.hidden=true;search.value='';filter();search.focus();};
  b.append(more);filter();
  disposeMap=mountPlacementMap(map,records,game.captureView(),indices=>{
    if(indices.length===1){visit(indices[0]);return;}
    subset=indices;search.value='';reset.hidden=false;filter();grid.firstElementChild?.focus();
  });
  const add=document.createElement('button');add.className='primary atlas-add';add.textContent='+  Place media here';add.disabled=!ready||busy;add.onclick=requestPhoto;b.append(add);icons(b);
}
function requestPhoto(){
  if(demo){placeBankPhoto();return;}
  if(busy||!ready)return;
  pendingPlacement={capture:game.captureView(),resume:playing};
  closeModal();game.pause();$('file').value='';$('file').click();
}
async function decodeImage(src){
  const img=new Image();img.decoding='async';img.src=src;await img.decode();return img;
}
function thumbnail(img){
  const w=img.naturalWidth||img.width,h=img.naturalHeight||img.height;
  const scale=Math.min(1,(isMobileRenderer()?384:720)/Math.max(w,h)),cv=document.createElement('canvas');
  cv.width=Math.max(1,Math.round(w*scale));cv.height=Math.max(1,Math.round(h*scale));
  cv.getContext('2d').drawImage(img,0,0,cv.width,cv.height);
  const url=cv.toDataURL('image/jpeg',.84);
  cv.width=cv.height=1;
  return url;
}
function nameRegion(name,kind){
  const stem=name.replace(/\.[^.]+$/,'').replace(/[_-]+/g,' ').trim();
  const defaults={industrial:'Industrial Yard',woodland:'Woodland',urban:'City Quarter',landscape:'Open Country',interior:'Interior',object:'Photo Garden'};
  return !stem||/^(img|cam|pxl|dsc|photo|image|screenshot|\d{3})/i.test(stem)?defaults[kind]||'Photo Region':stem.slice(0,55);
}
async function prepareFile(file,onProgress){
  if(isVideoFile(file)){
    const {profile,thumb}=await prepareVideo(file,{onProgress,makeThumbnail:thumbnail});
    return {name:file.name,title:nameRegion(file.name,profile.kind),thumb,profile};
  }
  const pixels=await importPixels(file,isMobileRenderer()?1280:Infinity);
  try{
    const profile=await analyzeImage(pixels.image,{onProgress,originalWidth:pixels.width,originalHeight:pixels.height});
    profile.imageBlob=await sourceBlob(pixels.image);profile.featureVersion=1;
    return {name:file.name,title:nameRegion(file.name,profile.kind),thumb:thumbnail(pixels.image),profile};
  }finally{pixels.release();}
}
async function historicalStarter(){
  const source=historyDeck[0],profile=await loadWalkProfile(source);
  profile.featureVersion=1;
  return {id:0,name:source.title,title:source.title,historyId:source.id,thumb:source.image,profile};
}
async function installView(record,options={}){
  const index=await game.addViewPhoto(record.profile,record.capture,options);
  views[index]=record;
  if(record.profile.video)clipViews.set(record.profile.video.id,record);
  if(demo&&!archiveOffered&&!record.bankSourceId&&(record.id==='region-0'||record.historyId)){
    exampleBank.push(record);
    renderBank();
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
      const missing=!savedBankSources.has(bankSourceId);
      await withStorableMedia(library,missing?{profile,thumb}:undefined,source=>new Promise((resolve,reject)=>{
        const tx=library.transaction(['settings','regions'],'readwrite');
        tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error);
        try{
          if(source)tx.objectStore('settings').put(source,'bank-source/'+bankSourceId);
          tx.objectStore('regions').put({...view,bankSourceId});
        }catch(error){tx.abort();reject(error);}
      }));
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
async function placeBankPhoto(automatic=false){
  if(!ready)return;
  const capture=game.captureView(),source=bank.take(exampleBank);
  if(!source){notice(bank.items.some(item=>item.file)?'The first item is still preparing.':'Load photos or videos in the Media bank to use B.');return;}
  walkingPlacement.placed(movementPose(),performance.now());
  if(automatic){
    const existing=views.findIndex(r=>r.bankSourceId===source.id&&sameAutoView(r.capture,capture));
    if(existing>=0){
      displayRegion(existing);notice('Revisiting '+source.title);queueSave();return;
    }
  }
  lastBankTime=Math.max(Date.now(),lastBankTime+1);
  const record={id:crypto.randomUUID(),created:lastBankTime,name:source.name,title:source.title,
    thumb:source.thumb,profile:source.profile,capture,bankSourceId:source.id};
  const preview=showBankPreview(game,source.profile,capture);
  bankPlacements++;renderBank();
  notice((automatic?'Auto · ':'')+source.title+' · '+heading(capture.yaw));
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
    notice('Placed · '+heading(capture.yaw));
  }catch(e){console.error(e);notice(e.name==='EncodingError'?'This browser could not decode that image. Try exporting it as JPEG, PNG, or WebP.':'Could not place this item. '+(e.message||'Try a different image.'));}
  finally{$('placement-status').hidden=true;busy=false;syncSuspension();buttons();}
  if(record){const saved=persistView(record);saveSettings();await saved;}
}
function updatePathAction(){
  const btn=$('path-action');btn.querySelector('span').textContent=views.length>1?'Open sitemap':'Try overlapping views';
  btn.title=views.length>1?'See captured camera positions and overlapping views':'Open a separate three-photo example';
  $('replay-placement').hidden=!game?.canReplayPlacement;
}
function wire(){
  if(demo){
    const archiveAction=document.querySelector('#touch-pad [data-act="photo"]');
    archiveAction.textContent='Atlas';archiveAction.setAttribute('aria-label','Open historical atlas');archiveAction.dataset.act='history';
    $('bank-entry').textContent='Use my media';$('bank-load').textContent='Open my media world';$('add-photo').textContent='Place from atlas';$('bank-rule').textContent='Walk 12 blocks or turn 35° to place the next historical image.';}
  icons();renderHotbar();compass(0);if(matchMedia('(pointer:coarse)').matches)document.querySelector('.entry-hint').textContent='Drag to aim · Use the arrows to walk';
  $('play').onclick=()=>game?.play();$('controls').onclick=showControls;$('notes').onclick=showNotes;$('view-atlas').onclick=showAtlas;$('view-world').onclick=()=>{closeModal();if(ready&&!busy)game.play();};
  $('history-browser')?.addEventListener('click',showHistory);
  $('enlarge').onclick=()=>inspectImage();$('vision-info').onclick=()=>inspectImage('vision');$('close-modal').onclick=closeModal;
  $('modal').addEventListener('click',e=>{if(e.target===$('modal')){const b=$('modal').getBoundingClientRect();if(e.clientX<b.left||e.clientX>b.right||e.clientY<b.top||e.clientY>b.bottom)closeModal();}});
  $('modal').onclose=()=>{disposeMap?.();disposeMap=null;if(inspectedURL){URL.revokeObjectURL(inspectedURL);inspectedURL=null;}syncSuspension();$('view-atlas').classList.remove('active');$('view-world').classList.add('active');};
  $('add-photo').onclick=requestPhoto;$('file').onchange=()=>addFile($('file').files[0],pendingPlacement);
  function chooseBank(startWalking){
    if(demo){location.assign('./?world=mine');return;}
    autoAfterPicker=startWalking||playing;
    game?.pause();$('bank-files').value='';$('bank-files').click();
  }
  $('bank-load').onclick=()=>chooseBank(false);
  $('bank-entry').onclick=()=>chooseBank(true);
  $('bank-files').onchange=()=>{
    const files=$('bank-files').files;
    if(!files.length)return;
    if(autoAfterPicker)bank.setAutomatic(true);
    bank.add(files);
    if(autoAfterPicker&&ready)game.play();
    autoAfterPicker=false;
    notice('Preparing '+files.length+' item'+(files.length===1?'':'s')+' on this device.');
  };
  $('bank-files').oncancel=()=>{autoAfterPicker=false;};
  $('bank-auto').onchange=event=>setAutomatic(event.target.checked);
  $('auto-hud').onclick=()=>setAutomatic(!automaticEnabled());
  $('clip-toggle').onclick=$('clip-hud').onclick=toggleClips;
  $('clip-position').oninput=()=>{
    if(!controlClip)return;
    game.videoField.seek(controlClip.id,Number($('clip-position').value));
    game.drawRequested=true;drawClipControls();queueSave();
  };
  $('bank-next').onclick=()=>placeBankPhoto();
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
    if(e.code==='KeyM'&&ready&&!e.target?.closest?.('input,textarea,select')){e.preventDefault();showAtlas();return;}
    if(e.code==='KeyB'){e.preventDefault();placeBankPhoto();}
    if(e.code==='KeyG'&&ready&&(exampleBank.length||bank.items.length)&&!e.target?.closest?.('input,textarea,select')){
      e.preventDefault();setAutomatic(!automaticEnabled());
    }
    if(e.code==='KeyU'){e.preventDefault();requestPhoto();}
    if(e.code==='Escape')$('inspector').classList.remove('open');
  });
  clearTouchPad=bindTouchPad($('touch-pad'),(code,down,id)=>game?.moveKey(code,down,id));
  for(const el of document.querySelectorAll('#touch-pad [data-act]'))el.onclick=()=>{
    if(el.dataset.act==='bank')placeBankPhoto();
    else if(el.dataset.act==='photo')requestPhoto();
    else if(el.dataset.act==='history')showHistory();
    else if(el.dataset.act==='pause')game.pause();
    else game.interact(el.dataset.act==='place');
  };
  window.addEventListener('dragover',e=>e.preventDefault());window.addEventListener('drop',e=>{e.preventDefault();if(!ready||busy)return;if(demo){notice('Open My media world to import files from your library.');return;}const files=e.dataTransfer.files;if(files.length>1){bank.add(files);notice('Preparing '+files.length+' bank items.');return;}const placement={capture:game.captureView(),resume:playing};closeModal();addFile(files[0],placement);});
  document.addEventListener('visibilitychange',()=>{if(document.hidden)saveSettings();});window.addEventListener('pagehide',saveSettings);
}
async function start(){
  wire();busy=true;buttons();
  if(demo){bankOpen=true;renderBank();}
  else bank.open().then(()=>{bankOpen=true;renderBank();});
  try{
    game=new Game($('scene'),{onStats,onPlay:playState,onSelect:selectedSlot,onEdit:queueSave,onNotice:notice});syncSuspension();
    historyDeck=await loadHistory(seed);walkStops=makeWalk(historyDeck);
    let records=[],saved=null,storedViews=[];
    if(!demo)try{
      [db,library]=await Promise.all([openDatabase(),openDatabase('strata-directional-photos-v1')]);
      const [oldRegions,oldSession,photos,session]=await Promise.all([readStore(db,'regions'),readStore(db,'settings','session'),readStore(library,'regions'),readStore(library,'settings','session')]);
      records=oldRegions;storedViews=photos.sort((a,b)=>a.created-b.created||String(a.id).localeCompare(String(b.id)));saved=session||oldSession;
    }catch{setSaved('Session only');}
    if(records[0]&&!records[0].historyId&&!records[0].profile.imageBlob&&!records[0].profile.video){
      const first=records[0];Object.assign(first,await historicalStarter());await persistRegion(first,true);
    }
    const flight=filmFlight?await import('./film-scene.js'):null;
    const flightFilms=flight?await flight.loadFlightFilms():null;
    if(!records.length){
      const r=flightFilms?flightFilms[0]:videoDemo?{id:0,name:'express.mp4',title:'New Black Diamond Express',thumb:'./assets/express.jpg',profile:await expressProfile()}:await historicalStarter();
      setLoading('Building '+r.title+'…');await new Promise(resolve=>setTimeout(resolve,0));r.anchor=await game.addRegion(r.profile);atlas.push(r);await persistRegion(r);
    }else{
      for(const r of records){
        setLoading('Restoring region '+pad(r.id+1)+'…');
        const p=r.profile;
        if(!p.imageBlob && !p.imageURL)p.imageURL=r.thumb;
        if(!p.featureVersion){
          try{
            p.photoFeatures ||= (await detectObjects(await decodeImage(r.thumb))).photoFeatures;
            p.featureVersion=1;await persistRegion(r,true);
          }catch{ /* RGB, depth and detection matches also work on legacy photos. */ }
        }
        await game.addRegion(p,r.anchor);atlas.push(r);
      }
      setSaved('Saved locally');
    }
    const legacyViews=atlas.map((r,i)=>{
      game.goTo(i);
      let capture=game.captureView();
      if(flightFilms)capture=flight.flightCapture(capture,r,0);
      if(videoDemo&&i===0){const y=capture.y+7;capture={...capture,y,eye:{...capture.eye,y}};}
      return {...r,id:'region-'+r.id,capture};
    });
    game.goTo(0);
    if(flightFilms){
      const r=flightFilms[1];r.capture=flight.flightCapture(game.captureView(),r,1);storedViews.push(r);
    }
    if(isMobileRenderer()||filmFlight)game.beginViewRestore();
    for(const [i,r] of legacyViews.entries())await installView(r,{reference:i===0,animate:false});
    walkOrigin=legacyViews[0].capture;
    if(requestedDemo==='views'||requestedDemo==='morph'){
      const origin=legacyViews[0].capture;
      for(const [i,stop] of walkStops.slice(1,3).entries()){
        const record=walkRecord(stop,await loadWalkProfile(stop));
        record.capture=cameraStamp({eye:origin.eye,yaw:origin.yaw+[22,46][i]*Math.PI/180,pitch:origin.pitch,fov:origin.fov,aspect:origin.aspect,near:origin.near,far:origin.far});
        storedViews.push(record);
      }
    }
    await restoreBankViews(storedViews);
    const newExample=requestedDemo==='views'&&!saved?.player&&storedViews.length===2;
    for(const r of storedViews){
      setLoading('Restoring '+r.title+'…');
      await installView(r,{prepareReplay:r===storedViews.at(-1),animate:newExample&&r===storedViews.at(-1)&&!matchMedia('(prefers-reduced-motion: reduce)').matches});
    }
    if(walkDemo){
      $('walk-link').hidden=true;
      nextWalkIndex();
      if(completedWalk)while(walkIndex<walkStops.length){
        const stop=walkStops[walkIndex];setLoading('Placing '+stop.title+' · '+(walkIndex+1)+' of '+walkStops.length+'…');
        const record=walkRecord(stop,await loadWalkProfile(stop));
        await installView(record,{animate:false,prepareReplay:walkIndex===walkStops.length-1});nextWalkIndex();
        await persistView(record);
      }
    }
    if(isMobileRenderer()||filmFlight)await game.finishViewRestore();
    Object.assign(settings,{mode:saved?.mode||'hybrid',opacity:saved?.opacity??(filmFlight?82:65),fov:saved?.fov||legacyViews[0].capture.fov});
    if(typeof saved?.sampleAutomatic==='boolean')sampleAutomatic=saved.sampleAutomatic;
    if(typeof saved?.walkAutomatic==='boolean')walkAutomatic=saved.walkAutomatic;
    if(saved?.clipsPlaying===false)game.videoField.setPlaying(false);
    for(const [id,time] of Object.entries(saved?.clipTimes||{})){
      if(clipViews.has(id)&&Number.isFinite(time))game.videoField.seek(id,time);
    }
    applySettings();
    if(saved?.player){
      const id=saved.preferredViewId??(saved.player.viewAspect?saved.selectedViewId:null);
      const preferred=views.findIndex(view=>view.id===id);
      if(preferred>=0)game.viewAtlas.preferredCapture=preferred;
      game.restoreState(saved.player);
    }
    else if(walkDemo)game.turnView(Math.atan2(walkStops[1].x,-walkStops[1].z));
    else if(filmFlight){game.flying=true;game.goToStamp(0);}
    else if(videoDemo)game.goToStamp(0);
    else if(requestedDemo==='views'||requestedDemo==='morph')game.turnView(22*Math.PI/180);
    let selectedIndex=views.findIndex(v=>v.id===saved?.selectedViewId);
    if(overlapStudy){
      selectedIndex=views.findIndex(v=>v.historyId===walkStops[3].id);
      if(selectedIndex>=0){
        game.goToStamp(selectedIndex);game.flying=false;
        game.turnView(49*Math.PI/180-game.yaw,Math.PI/180-game.pitch);
      }
    }
    displayRegion(selectedIndex>=0?selectedIndex:demo&&!walkDemo&&!filmFlight?Math.min(1,views.length-1):0);updateViewHUD(latestStats);
    ready=true;busy=false;syncSuspension();buttons();updatePathAction();$('load').hidden=true;$('connection').textContent='World ready';
    if(demo){
      $('demo-back').hidden=false;setSaved('Public atlas');
      if(filmFlight){exampleBank.splice(0,exampleBank.length,...views);renderBank();}
      else offerArchive();
      if(autoDemo)$('auto-link').hidden=true;
      if(filmFlight)$('film-link').hidden=true;
      document.querySelector('.entry-hint').textContent=videoDemo?'The train moves as you watch · Enter to explore':'Walk or turn to place the next historical image';
    }
    if(filmFlight){
      document.body.classList.add('film-demo');
      flight.watchFlight(game,$('watch-flight'),$('stop-flight'),displayRegion);
      document.querySelector('.entry-hint').textContent='Fly freely or watch the two-film transition';
    }
    if(walkDemo){
      document.querySelector('.entry-hint').textContent=walkIndex<walkStops.length?'Walk toward the next photo · Select its waypoint to jump there':'Explore 11 photos · Sitemap recalls any viewpoint';
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
