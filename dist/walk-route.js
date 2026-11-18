import {cameraStamp} from './view-volume.js';
import {sampleProfile} from './photo-assets.js';

// Each visit assigns a different source to these overlapping capture positions.
const path = [[0,0,0,0],[7,-5,28,2],[18,-6,62,0],[34,0,27,-2],[51,6,2,2],[70,9,30,-4],[89,6,12,-1],[111,4,35,6],[130,11,-4,-2],[148,17,25,-7],[169,22,5,3]];
export function makeWalk(deck) {
  return deck.slice(0,path.length).map((source,i)=>{
    const [x,z,yaw,pitch]=path[i];
    return {...source,x,z,yaw,pitch};
  });
}
export function walkCapture(game,stop,origin) {
  if(stop.x===0&&stop.z===0)return origin;
  const x=origin.eye.x+stop.x,z=origin.eye.z+stop.z;
  return cameraStamp({eye:{x,y:game.world.getGround(x,z)+1.675,z},
    yaw:origin.yaw+stop.yaw*Math.PI/180,pitch:stop.pitch*Math.PI/180,
    fov:origin.fov,aspect:origin.aspect,near:origin.near,far:origin.far});
}
export const loadWalkProfile = source => sampleProfile('history/'+source.id);
