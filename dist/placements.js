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

export function placementMap(views,camera){
  const canvas=document.createElement('canvas'),width=456,height=156;
  canvas.width=width*2;canvas.height=height*2;canvas.className='atlas-map';
  canvas.setAttribute('role','img');
  canvas.setAttribute('aria-label','Top-down plan of captured camera directions and their overlapping fields of view');
  const ctx=canvas.getContext('2d');ctx.scale(2,2);
  const cones=views.map(({capture:c})=>{
    const radius=27, angle=Math.atan(Math.tan(c.fov*Math.PI/360)*c.aspect);
    return [c.eye,...[-angle,0,angle].map(delta=>({x:c.eye.x+radius*Math.sin(c.yaw+delta),z:c.eye.z-radius*Math.cos(c.yaw+delta)}))];
  });
  const points=cones.flat();
  if(camera)points.push(camera.eye);
  if(!points.length)return canvas;
  let x0=Infinity,z0=Infinity,x1=-Infinity,z1=-Infinity;
  for(const p of points){x0=Math.min(x0,p.x);z0=Math.min(z0,p.z);x1=Math.max(x1,p.x);z1=Math.max(z1,p.z);}
  const scale=Math.min((width-58)/Math.max(45,x1-x0),(height-40)/Math.max(34,z1-z0));
  const px=p=>width/2+(p.x-(x0+x1)/2)*scale, py=p=>height/2+(p.z-(z0+z1)/2)*scale;
  ctx.fillStyle='#182018';ctx.fillRect(0,0,width,height);
  ctx.lineWidth=.7;ctx.strokeStyle='#343f30';ctx.beginPath();
  const step=2**Math.round(Math.log2(24/scale))*scale;
  for(let i=px({x:0})%step;i<width;i+=step){ctx.moveTo(i,0);ctx.lineTo(i,height);}
  for(let i=py({z:0})%step;i<height;i+=step){ctx.moveTo(0,i);ctx.lineTo(width,i);}
  ctx.stroke();
  cones.forEach(([a,l,c,r],i)=>{
    const ink=placementColor(i);
    ctx.beginPath();ctx.moveTo(px(a),py(a));ctx.lineTo(px(l),py(l));ctx.lineTo(px(c),py(c));ctx.lineTo(px(r),py(r));ctx.closePath();
    ctx.fillStyle=ink+'2e';ctx.fill();ctx.strokeStyle=ink+'ad';ctx.stroke();
    ctx.fillStyle=ink;ctx.fillRect(px(a)-2,py(a)-2,4,4);
  });
  if(camera){const p=camera.eye,x=px(p),y=py(p);ctx.save();ctx.translate(x,y);ctx.rotate(camera.yaw);ctx.beginPath();
    ctx.moveTo(0,-7);ctx.lineTo(4.5,4);ctx.lineTo(0,2);ctx.lineTo(-4.5,4);ctx.closePath();ctx.strokeStyle='#142311';ctx.lineWidth=2;ctx.stroke();ctx.fillStyle='#f4fae8';ctx.fill();ctx.restore();}
  ctx.fillStyle='#cad3c1';ctx.font='10px monospace';ctx.fillText('↑ N',10,16);
  return canvas;
}
