const toDegrees=180/Math.PI;
export function heading(yaw){
  const value=((Math.round(yaw*toDegrees)%360)+360)%360;
  return ['N','NE','E','SE','S','SW','W','NW'][Math.round(value/45)%8]+' '+String(value).padStart(3,'0')+'°';
}
export function describePose(view){
  return heading(view.yaw)+' · '+Math.round(view.pitch*toDegrees)+'° pitch · '+Math.round(view.fov)+'° lens';
}
const inks=['#d2f77c','#99c7f3','#e6a98f','#b7a9e7','#8adac3','#edcf93'];
export function placementColor(index){return inks[index%inks.length];}

// A pin groups only viewpoints whose touch targets would overlap on this screen.
// Keep the original placement indices so clicking a pin never reconstructs a pose.
export function mapLayout(views,camera,width,height){
  const cones=views.map(({capture:c})=>{
    const half=Math.atan(Math.tan(c.fov*Math.PI/360)*c.aspect),reach=18;
    return [c.eye,...[-half,0,half].map(delta=>({
      x:c.eye.x+reach*Math.sin(c.yaw+delta),z:c.eye.z-reach*Math.cos(c.yaw+delta)
    }))];
  });
  let left=camera.eye.x,right=left,top=camera.eye.z,bottom=top;
  for(const cone of cones)for(const p of cone){
    left=Math.min(left,p.x);right=Math.max(right,p.x);
    top=Math.min(top,p.z);bottom=Math.max(bottom,p.z);
  }
  const scale=Math.min((width-64)/Math.max(26,right-left),(height-58)/Math.max(20,bottom-top));
  const project=p=>({x:width/2+(p.x-(left+right)/2)*scale,y:height/2+(p.z-(top+bottom)/2)*scale});
  const shapes=cones.map(cone=>cone.map(project)),pins=[];
  shapes.forEach(([eye],index)=>{
    const pin=pins.find(p=>Math.abs(eye.x-p.x)<44 && Math.abs(eye.y-p.y)<44);
    if(pin)pin.indices.push(index);
    else pins.push({...eye,indices:[index]});
  });
  return {shapes,pins,player:project(camera.eye),origin:project({x:0,z:0}),scale};
}

export function mountPlacementMap(board,views,camera,pick){
  const canvas=document.createElement('canvas'),pins=document.createElement('div');
  canvas.setAttribute('aria-hidden','true');
  pins.setAttribute('role','group');pins.setAttribute('aria-label','Map locations');
  board.className='placement-map';board.append(canvas,pins);
  function draw(){
    const w=board.clientWidth,h=board.clientHeight;
    if(w<68||h<62)return;
    const ratio=Math.min(window.devicePixelRatio||1,2);
    canvas.width=Math.round(w*ratio);canvas.height=Math.round(h*ratio);
    const ctx=canvas.getContext('2d');ctx.scale(canvas.width/w,canvas.height/h);
    const {shapes,pins:groups,player,origin,scale}=mapLayout(views,camera,w,h);
    const units=2**Math.round(Math.log2(35/scale)),step=units*scale;
    ctx.strokeStyle='#354050';ctx.lineWidth=1;ctx.beginPath();
    for(let x=origin.x%step;x<w;x+=step){ctx.moveTo(x,0);ctx.lineTo(x,h);}
    for(let y=origin.y%step;y<h;y+=step){ctx.moveTo(0,y);ctx.lineTo(w,y);}
    ctx.stroke();
    shapes.forEach(([eye,l,c,r],i)=>{
      const ink=placementColor(i);
      ctx.beginPath();ctx.moveTo(eye.x,eye.y);ctx.lineTo(l.x,l.y);ctx.lineTo(c.x,c.y);ctx.lineTo(r.x,r.y);ctx.closePath();
      ctx.fillStyle=ink+'1d';ctx.fill();ctx.strokeStyle=ink+'a8';ctx.stroke();
    });
    ctx.fillStyle='#dddfe6';ctx.font='11px monospace';ctx.fillText('↑ N',9,16);
    ctx.fillText(units+' blocks',9,h-8);
    ctx.save();ctx.translate(player.x,player.y);ctx.rotate(camera.yaw);
    // The tip stays outside a pin if the player stands at its capture eye.
    ctx.beginPath();ctx.moveTo(0,-24);ctx.lineTo(5,-14);ctx.lineTo(0,-17);ctx.lineTo(-5,-14);ctx.closePath();
    ctx.strokeStyle='#101326';ctx.lineWidth=3;ctx.stroke();ctx.fillStyle='#fff';ctx.fill();ctx.restore();
    const focused=pins.contains(document.activeElement)?document.activeElement.dataset.first:null;
    const buttons=groups.map(({x,y,indices})=>{
      const index=indices[0],single=indices.length===1,button=document.createElement('button');
      button.type='button';button.className='map-pin';button.dataset.first=String(index);
      button.style.left=x+'px';button.style.top=y+'px';button.style.setProperty('--ink',placementColor(index));
      const badge=document.createElement('span');badge.textContent=single?String(index+1):'×'+indices.length;
      button.append(badge);
      const label=single?'Go to view '+(index+1)+' · '+views[index].title:'Choose from '+indices.length+' views at this spot';
      button.title=label;button.setAttribute('aria-label',label);button.onclick=()=>pick(indices);
      return button;
    });
    pins.replaceChildren(...buttons);
    if(focused!==null)pins.querySelector('[data-first="'+focused+'"]')?.focus({preventScroll:true});
  }
  const observer=new ResizeObserver(draw);
  observer.observe(board);draw();
  return ()=>observer.disconnect();
}
