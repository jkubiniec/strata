import { cameraStamp } from './view-volume.js';
import { sampleProfile } from './photo-assets.js';

// X and Z are block offsets from the refinery. Angles are in degrees.
export const WALK_STOPS = [
  {id:'refinery', title:'Refinery Yard', x:0, z:0, yaw:0, pitch:0, image:'./assets/refinery-preview.jpg'},
  {id:'launch', title:'Launch Pad', x:7, z:-5, yaw:28, pitch:2, image:'./assets/launch.jpg'},
  {id:'astronaut', title:'Eileen Collins', x:18, z:-6, yaw:62, pitch:0, image:'./assets/astronaut.png'},
  {id:'arch', title:'Delicate Arch', x:34, z:0, yaw:27, pitch:-2},
  {id:'dunes', title:'Great Sand Dunes', x:51, z:6, yaw:2, pitch:2},
  {id:'glacier', title:'Grinnell Glacier Basin', x:70, z:9, yaw:30, pitch:-4},
  {id:'boardwalk', title:'Geyser Boardwalk', x:89, z:6, yaw:12, pitch:-1},
  {id:'redwoods', title:'Redwood Canopy', x:111, z:4, yaw:35, pitch:6},
  {id:'bison', title:'Bison in the Fog', x:130, z:11, yaw:-4, pitch:-2},
  {id:'hot-spring', title:'Grand Prismatic Spring', x:148, z:17, yaw:25, pitch:-7},
  {id:'aurora', title:'Glacier Aurora', x:169, z:22, yaw:5, pitch:3}
].map(stop=>({...stop,image:stop.image||'./assets/walk/'+stop.id+'.jpg'}));

export function walkCapture(game,stop,origin) {
  if(stop.id==='refinery')return origin;
  const x=origin.eye.x+stop.x,z=origin.eye.z+stop.z;
  return cameraStamp({eye:{x,y:game.world.getGround(x,z)+1.675,z},
    yaw:origin.yaw+stop.yaw*Math.PI/180,pitch:stop.pitch*Math.PI/180,
    fov:origin.fov,aspect:origin.aspect,near:origin.near,far:origin.far});
}

export function loadWalkProfile(stop) {
  return sampleProfile(stop.image.startsWith('./assets/walk/')?'walk/'+stop.id:stop.id);
}
