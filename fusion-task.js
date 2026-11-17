// A placement can rebuild several intersecting views. Send their read-only
// source arrays once, then transfer each finished grid and color texture back.
export function beginFusion(records,computeLocally) {
  let worker=null,pending=null;
  function stop(error) {
    worker?.terminate();worker=null;
    if(pending){pending.reject(error);pending=null;}
  }
  if(typeof Worker==='function'){
    try{
      worker=new Worker(new URL('./fusion-worker.js?v=3.5',import.meta.url),{type:'module',name:'Strata photo fusion'});
      worker.onerror=event=>{event.preventDefault();stop(new Error(event.message||'Photo worker unavailable'));};
      worker.onmessageerror=()=>stop(new Error('Photo worker returned unreadable data'));
      worker.onmessage=({data})=>{
        if(!pending)return;
        const request=pending;pending=null;
        if(data.error)request.reject(new Error(data.error));else request.resolve(data);
      };
      const sources=Array.from(records,r=>{
        const {gridW,gridH,depth,skyMask,detail}=r.profile;
        return {id:r.id,s:r.s,budget:r.budget,cropX:r.cropX,cropY:r.cropY,source:r.source,profile:{gridW,gridH,depth,skyMask,detail}};
      });
      worker.postMessage({sources});
    }catch(error){stop(error);}
  }
  return {
    async sample(record) {
      if(worker){
        try{
          const result=await new Promise((resolve,reject)=>{
            pending={resolve,reject};
            worker.postMessage({id:record.id,neighbors:record.neighbors.map(n=>n.id),flows:record.flows});
          });
          result.grid.neighbors=[record,...record.neighbors];
          return result;
        }catch(error){stop(error);}
      }
      return computeLocally(record);
    },
    close(){stop(new Error('Photo fusion finished'));}
  };
}
