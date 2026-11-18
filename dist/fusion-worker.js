import { computePhotoSamples } from './view-volume.js?v=4.1';

let records;
self.onmessage=({data})=>{
  try{
    if(data.sources){
      records=new Map(data.sources.map(record=>[record.id,record]));
      return;
    }
    const record=records.get(data.id);
    record.neighbors=data.neighbors.map(id=>records.get(id));
    record.flows=data.flows;
    const {grid,image}=computePhotoSamples(record);
    // Only the numeric grid is needed across the boundary. The main thread
    // already owns the photo records and their live meshes.
    delete grid.neighbors;
    const arrays=[grid.depths,grid.skies,grid.owned,...grid.maps,image.data];
    self.postMessage({grid,image},arrays.map(array=>array.buffer));
  }catch(error){self.postMessage({error:String(error.message||error)});}
};
