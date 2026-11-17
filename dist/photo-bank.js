import { openDatabase, readStore, writeStore } from './interface.js';

// Advance past unavailable entries, preserving the order supplied by the picker.
export function nextReady(items,lastId) {
  const previous=items.findIndex(item=>item.id===lastId);
  for(let offset=1;offset<=items.length;offset++){
    const item=items[(previous+offset)%items.length];
    if(item.profile)return item;
  }
  return null;
}

const rad=Math.PI/180;
const cosAngle=(a,b)=>Math.sin(a.pitch)*Math.sin(b.pitch)+Math.cos(a.pitch)*Math.cos(b.pitch)*Math.cos(a.yaw-b.yaw);
const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);

// Compare viewing directions on the sphere so north crossings and looking
// almost straight up don't create artificial turn events.
export function sameAutoView(a,b) {
  return distance(a,b)<3 && cosAngle(a,b)>Math.cos(8*rad);
}

export class WalkingPlacement {
  reset(pose) {
    this.anchor=this.previous=pose;
    this.lastPlacement=-Infinity;
  }

  placed(pose,now) {
    this.anchor=this.previous=pose;
    this.lastPlacement=now;
  }

  update(pose,now,available) {
    if(!this.previous){this.reset(pose);return false;}
    const moved=distance(this.previous,pose)>.015 || cosAngle(this.previous,pose)<Math.cos(.12*rad);
    this.previous=pose;
    if(!available||!moved||now-this.lastPlacement<2400)return false;
    if(distance(this.anchor,pose)<12 && cosAngle(this.anchor,pose)>Math.cos(35*rad))return false;
    this.placed(pose,now);
    return true;
  }
}

export class PhotoBank {
  constructor(prepare,changed,storageWarning) {
    this.prepare=prepare;
    this.changed=changed;
    this.storageWarning=storageWarning;
    this.items=[];
    this.byId=new Map();
    this.lastId=null;
    this.automatic=true;
    this.preparing=false;
    this.saving=true;
  }

  async open() {
    try{
      this.db=await openDatabase('strata-source-bank-v1');
      const [items,lastId,automatic]=await Promise.all([
        readStore(this.db,'regions'),readStore(this.db,'settings','lastId'),readStore(this.db,'settings','automatic')
      ]);
      items.sort((a,b)=>a.order-b.order||a.id.localeCompare(b.id));
      this.items=items;
      this.byId=new Map(items.map(item=>[item.id,item]));
      this.lastId=lastId??null;
      this.automatic=automatic!==false;
    }catch{this.warnStorage();}
    this.changed();
    this.preparePending();
  }

  setAutomatic(enabled) {
    this.automatic=enabled;
    this.save('settings',enabled,'automatic');
    this.changed();
  }

  warnStorage() {
    if(this.saving)this.storageWarning();
    this.saving=false;
  }

  async save(store,item,key) {
    if(!this.db||!this.saving)return;
    try{await writeStore(this.db,store,item,key);}
    catch{this.warnStorage();}
  }

  add(files) {
    let order=Math.max(Date.now(),(this.items.at(-1)?.order??0)+1);
    for(const file of files){
      const item={id:crypto.randomUUID(),name:file.name,order:order++,file};
      this.items.push(item);
      this.byId.set(item.id,item);
      // Persist the source first so an interrupted analysis can resume on reload.
      this.save('regions',item);
    }
    this.changed();
    this.preparePending();
  }

  async preparePending() {
    if(this.preparing)return;
    this.preparing=true;
    try{
      for(const item of this.items){
        if(!item.file)continue;
        try{Object.assign(item,await this.prepare(item.file));}
        catch{item.failed=true;}
        delete item.file;
        await this.save('regions',item);
        this.changed();
        await new Promise(resolve=>setTimeout(resolve,0));
      }
    }finally{this.preparing=false;}
  }

  next(examples=[]) {
    return nextReady(this.items.length?this.items:examples,this.lastId);
  }

  take(examples) {
    const item=this.next(examples);
    if(item){
      this.lastId=item.id;
      this.save('settings',item.id,'lastId');
      this.changed();
    }
    return item;
  }
}
