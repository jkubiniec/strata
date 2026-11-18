// All positions are foot offsets from the Apollo capture. Both stops are
// above the terrain so the player can circle the projected film surfaces.
export const flightAltitude=30;
const radians=Math.PI/180;
const pose=(x,y,z,yaw,pitch)=>({x,y,z,yaw:yaw*radians,pitch:pitch*radians,fov:56});
export const flightStops=[
  pose(0,0,0,0,0),
  pose(17,1,-5,-12.5,-1)
];
export const flightDuration=13.4;
const depart=2.3,arrive=11.2;
const path=[
  [depart,flightStops[0]],
  [4.9,pose(-12,3.4,8,11,-2.5)],
  [8.7,pose(8,2.4,3,-5,-2)],
  [arrive,flightStops[1]]
];
const ease=x=>{x=Math.max(0,Math.min(1,x));return x*x*(3-2*x);};
const lerp=(a,b,t)=>a+(b-a)*t;
export function flightPose(seconds){
  if(seconds<=depart)return {...flightStops[0],frame:{source:0,amount:1}};
  if(seconds>=arrive)return {...flightStops[1],frame:{source:1,amount:1}};
  const to=path.findIndex(([time])=>seconds<=time);
  const [begin,a]=path[to-1],[end,b]=path[to];
  const u=ease((seconds-begin)/(end-begin));
  const source=(seconds-depart)<1.35?0:1;
  // A recalled native-aspect image opens smoothly into the live viewport,
  // then closes to the other film's original framing as the player arrives.
  const amount=source===0?1-ease((seconds-depart)/1.35):ease((seconds-arrive+1.35)/1.35);
  return {
    x:lerp(a.x,b.x,u),y:lerp(a.y,b.y,u),z:lerp(a.z,b.z,u),
    yaw:lerp(a.yaw,b.yaw,u),pitch:lerp(a.pitch,b.pitch,u),fov:56,
    frame:{source,amount}
  };
}
