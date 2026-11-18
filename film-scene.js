import {filmProfile} from './photo-assets.js';
import {cameraStamp} from './view-volume.js';
import {flightAltitude, flightStops, flightDuration, flightPose} from './flight-path.js';

const films=[
  ['apollo','Apollo 11 liftoff'],
  ['discovery','Discovery’s final landing']
];

export async function loadFlightFilms(){
  return Promise.all(films.map(async([name,title],i)=>{
    const asset='flight/'+name;
    return {id:i===0?0:'flight-'+name,title,name:name+'.mp4',thumb:'./assets/'+asset+'.jpg',profile:await filmProfile(asset)};
  }));
}

export function flightCapture(origin,record,index){
  const stop=flightStops[index];
  const eye={x:origin.eye.x+stop.x,y:origin.eye.y+flightAltitude+stop.y,z:origin.eye.z+stop.z};
  return cameraStamp({eye,flying:true,yaw:stop.yaw,pitch:stop.pitch,fov:stop.fov,
    aspect:record.profile.width/record.profile.height,near:origin.near,far:origin.far});
}

// The guided flight moves the same camera the player uses. Stopping leaves
// the viewer at the current pose and never rewinds a clip's playback clock.
export function watchFlight(game,button,stopButton,onArrive){
  let frame=0,origin,started,lastStamp;
  function stop(){
    cancelAnimationFrame(frame);
    frame=0;
    document.body.classList.remove('watching-flight');
    stopButton.hidden=true;
  }
  function tick(now){
    if(game.playing||game.suspended||document.hidden){stop();return;}
    const elapsed=(now-started)/1000;
    const pose=flightPose(elapsed);
    const {source,amount}=pose.frame;
    if(amount===1){
      if(lastStamp!==source){game.goToStamp(source);onArrive(source);}
      lastStamp=source;
    }else{
      lastStamp=null;
      const [w,h]=game.drawSize;
      const screen=w/h, saved=game.stamps[source].capture.aspect;
      const aspect=amount>0?screen+(saved-screen)*amount:null;
      if(game.recalledAspect!==aspect){
        game.recalledAspect=aspect;
        game.updateViewport();game.updateLens();
      }
      game.position.set(origin.x+pose.x,origin.y+pose.y,origin.z+pose.z);
      game.yaw=pose.yaw;
      game.pitch=pose.pitch;
      game.updateCamera();
      game.drawRequested=true;
    }
    if(elapsed>=flightDuration){stop();return;}
    frame=requestAnimationFrame(tick);
  }
  button.onclick=()=>{
    stop();
    game.goToStamp(0);
    game.flying=true;
    game.videoField.setPlaying(true);
    origin=game.position.clone();
    lastStamp=null;
    started=performance.now();
    document.body.classList.add('watching-flight');
    stopButton.hidden=false;
    stopButton.focus({preventScroll:true});
    tick(started);
  };
  stopButton.onclick=()=>{stop();button.focus({preventScroll:true});};
  document.addEventListener('pointerdown',e=>{if(frame&&!stopButton.contains(e.target))stop();},{capture:true});
  document.addEventListener('keydown',e=>{if(frame&&e.code!=='Tab'){stop();if(e.code==='Escape')button.focus({preventScroll:true});}},{capture:true});
  document.addEventListener('visibilitychange',()=>{if(document.hidden)stop();});
  button.hidden=false;
}
