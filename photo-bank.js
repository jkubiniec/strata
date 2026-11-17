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

export class PhotoBank {
  constructor(prepare,changed,storageWarning) {
    this.prepare=prepare;
    this.changed=changed;
    this.storageWarning=storageWarning;
    this.items=[];
    this.byId=new Map();
    this.lastId=null;
    this.preparing=false;
    this.saving=true;
  }

  async open() {
    try{
      this.db=await openDatabase('strata-source-bank-v1');
      const [items,lastId]=await Promise.all([
        readStore(this.db,'regions'),readStore(this.db,'settings','lastId')
      ]);
      items.sort((a,b)=>a.order-b.order||a.id.localeCompare(b.id));
      this.items=items;
      this.byId=new Map(items.map(item=>[item.id,item]));
      this.lastId=lastId??null;
    }catch{this.warnStorage();}
    this.changed();
    this.preparePending();
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
