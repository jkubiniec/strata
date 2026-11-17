// Each lattice point represents the same piece of two source photographs.
// Transporting its UV coordinates before backprojection keeps a moving edge
// from appearing as two stationary, half-transparent copies of itself.
import * as THREE from './vendor/three.module.js';

const clamp = (x, a=0, b=1) => Math.max(a,Math.min(b,x));
const mix = (a,b,t) => a+(b-a)*t;
const sq = x => x*x;

function sample(profile,u,v) {
  const x=clamp(Math.floor(u*profile.gridW),0,profile.gridW-1);
  const y=clamp(Math.floor(v*profile.gridH),0,profile.gridH-1), i=x+y*profile.gridW;
  return [profile.rgb[i*3]/255,profile.rgb[i*3+1]/255,profile.rgb[i*3+2]/255,profile.depth[i]];
}
function luma(c) {return c[0]*.213+c[1]*.715+c[2]*.072;}
function semantic(profile,u,v) {
  const f=profile.photoFeatures;
  if (!f || !f.values || !f.channels || f.values.length!==f.width*f.height*f.channels) return null;
  const col=clamp(Math.floor(u*f.width),0,f.width-1), row=clamp(Math.floor(v*f.height),0,f.height-1);
  const i=(row*f.width+col)*f.channels;
  return f.values.subarray(i,i+f.channels);
}

function colorBin(c) {
  const high=Math.max(c[0],c[1],c[2]),low=Math.min(c[0],c[1],c[2]),range=high-low;
  if(range<.115 || range<high*.22) return Math.min(3,Math.floor(luma(c)*4));
  const hue=high===c[0]?(c[1]-c[2])/range:high===c[1]?2+(c[2]-c[0])/range:4+(c[0]-c[1])/range;
  return 4+((Math.round(hue*2)+12)%12);
}
function regionsOfColor(profile) {
  const w=54,h=42,bins=new Int16Array(w*h),visited=new Uint8Array(w*h),queue=new Uint16Array(w*h),parts=[];
  for(let i=0;i<bins.length;i++) bins[i]=colorBin(sample(profile,((i%w)+.5)/w,(Math.floor(i/w)+.5)/h));
  for(let start=0;start<w*h;start++) {
    if(visited[start])continue;
    let n=1,k=0,sx=0,sy=0,x0=w,x1=0,y0=h,y1=0;const color=[0,0,0,0];
    queue[0]=start;visited[start]=1;
    function visit(j){if(!visited[j]&&bins[j]===bins[start]){visited[j]=1;queue[n++]=j;}}
    while(k<n){
      const i=queue[k++],x=i%w,y=Math.floor(i/w),c=sample(profile,(x+.5)/w,(y+.5)/h);
      sx+=x+.5;sy+=y+.5;x0=Math.min(x,x0);x1=Math.max(x,x1);y0=Math.min(y,y0);y1=Math.max(y,y1);
      for(let j=0;j<4;j++)color[j]+=c[j];
      if(x>0)visit(i-1);if(x<w-1)visit(i+1);if(y>0)visit(i-w);if(y<h-1)visit(i+w);
    }
    const area=n/(w*h);
    if(area<.004 || area>.65)continue;
    const u=sx/n/w,v=sy/n/h;
    parts.push({u,v,w:(x1-x0+1)/w,h:(y1-y0+1)/h,area,c:color.map(value=>value/n)});
  }
  return parts.sort((a,b)=>b.area-a.area).slice(0,32);
}
function patchSamples(profile) {
  const points=[];
  for(let y=0;y<15;y++)for(let x=0;x<19;x++){
    const u=(x+.5)/19,v=(y+.5)/15;
    const feature=sample(profile,u,v);let strength=0;
    for(const [du,dv] of [[-.047,0],[.047,0],[0,-.057],[0,.057],[-.12,0],[.12,0],[0,-.13],[0,.13]]){
      const c=sample(profile,u+du,v+dv);
      const chroma=luma(c)-luma(feature);
      strength+=Math.abs(chroma)+.27*Math.abs(c[3]-feature[3]);
      feature.push(chroma,c[0]-c[2],c[1]-(c[0]+c[2])*.5);
    }
    if(strength>.10)points.push({u,v,feature,strength,learned:semantic(profile,u,v)});
  }
  return points;
}
function featureCost(a,b) {
  let error=0;
  for(let i=0;i<3;i++)error+=sq(a.feature[i]-b.feature[i])*.45;
  error+=sq(a.feature[3]-b.feature[3])*.16;
  for(let i=4;i<a.feature.length;i++)error+=sq(a.feature[i]-b.feature[i])*(i%3===1?.21:.09);
  if(a.learned && b.learned && a.learned.length===b.learned.length){
    let dot=0;
    for(let i=0;i<a.learned.length;i++)dot+=a.learned[i]*b.learned[i];
    error+=.48*Math.max(0,1-dot/16129);
  }
  return error+.04*(sq(a.u-b.u)+sq(a.v-b.v));
}
function labelMatches(a,b,out) {
  const boxes=b.detections||[],used=new Set();
  for(const x of (a.detections||[]).slice().sort((p,q)=>q.score*q.w*q.h-p.score*p.w*p.h)){
    let winner=-1,best=Infinity;
    const w=x.w,h=x.h;
    if(w*h<.012)continue;
    for(let i=0;i<boxes.length;i++){
      const y=boxes[i];
      if(used.has(i)||y.label!==x.label)continue;
      const cost=Math.abs(Math.log((w*h+.001)/(y.w*y.h+.001)))+.5*Math.hypot(x.x-y.x,x.y-y.y);
      if(cost<best){winner=i;best=cost;}
    }
    if(winner<0)continue;
    used.add(winner);const y=boxes[winner];
    for(const [u,v] of [[.5,.5],[.18,.5],[.82,.5],[.5,.18],[.5,.82]]){
      out.push({x:x.x+w*u,y:x.y+h*v,tx:y.x+y.w*u,ty:y.y+y.h*v,w:4.5,r:.15});
    }
  }
}
// Sustained, same-polarity image gradients reveal rails, horizons and
// structural shafts that should travel as rigid lines during a photo warp.
function lineSegments(profile) {
  const n=160,lum=new Float32Array(n*n);
  for(let j=0;j<n;j++)for(let i=0;i<n;i++)lum[j*n+i]=luma(sample(profile,(i+.5)/n,(j+.5)/n));
  const result=[];
  for(const vertical of [true,false])for(const tilt of [0,-.055,.055,-.13,.13]){
    for(let offset=2;offset<n-2;offset++){
      let start=0,last=0,count=0,sum=0,sign=0;
      function finish(){
        const length=last-start+1;
        if(length>n*.275 && count>.53*length){
          const begin=(start+.5)/n,end=(last+.5)/n,level=(offset+.5)/n;
          result.push({vertical,tilt,level,begin,end,score:length/n*(sum/length)**.7});
        }
        count=0;sum=0;sign=0;
      }
      for(let t=1;t<n-1;t++){
        const ortho=Math.round(offset+(t-n*.5)*tilt);
        let g=0;
        if(ortho>1&&ortho<n-2){
          const i=vertical?t*n+ortho:ortho*n+t,d=vertical?1:n;
          g=lum[i+d]-lum[i-d];
        }
        if(count && (t-last>Math.ceil(n*.052) || Math.abs(g)>.07 && Math.sign(g)!==sign))finish();
        if(Math.abs(g)<.048 || count && Math.sign(g)!==sign)continue;
        if(!count){start=t;sign=Math.sign(g);}
        last=t;count++;sum+=Math.abs(g);
      }
      finish();
    }
  }
  const keep=[];
  for(const line of result.sort((a,b)=>b.score-a.score)){
    if(keep.some(q=>q.vertical===line.vertical && Math.abs(line.level-q.level)<.06 &&
      Math.min(line.end,q.end)-Math.max(line.begin,q.begin)>.25*Math.min(line.end-line.begin,q.end-q.begin)))continue;
    keep.push(line);if(keep.length>=16)break;
  }
  return keep;
}
function linePoint(q,t){
  const u=mix(q.begin,q.end,t),v=q.level+(u-.5)*q.tilt;
  return q.vertical?[v,u]:[u,v];
}
function lineMatches(a,b){
  const left=lineSegments(a),right=lineSegments(b),candidates=[];
  for(const p of left)for(const q of right){
    if(p.vertical!==q.vertical || Math.abs(p.level-q.level)>.20)continue;
    const spanA=p.end-p.begin,spanB=q.end-q.begin;
    const cost=3.2*Math.abs(p.level-q.level)+.30*Math.abs(Math.log(spanA/spanB))+
      .38*Math.abs(p.tilt-q.tilt)+.22*Math.abs((p.begin+p.end-q.begin-q.end)*.5);
    if(cost>.85)continue;
    candidates.push({p,q,score:Math.sqrt(p.score*q.score)/(cost+.14)});
  }
  const pairs=[];
  for(const c of candidates.sort((a,b)=>b.score-a.score)){
    if(pairs.some(k=>k.p===c.p || k.q===c.q || k.p.vertical===c.p.vertical &&
      (k.p.level-c.p.level)*(k.q.level-c.q.level)<0))continue;
    pairs.push(c);
  }
  return pairs;
}
function landmarks(a,b) {
  const out=[];
  labelMatches(a,b,out);
  const aa=regionsOfColor(a),bb=regionsOfColor(b);
  function componentCost(x,y){
    const color=sq(x.c[0]-y.c[0])+sq(x.c[1]-y.c[1])+sq(x.c[2]-y.c[2]);
    return color*2.5+sq(Math.log((x.area+.002)/(y.area+.002)))*.09+
      sq(Math.log((x.w/x.h)/(y.w/y.h)))*.065+.032*(sq(x.u-y.u)+sq(x.v-y.v));
  }
  for(const x of aa){
    let best=.47,y=null;
    for(const other of bb){const cost=componentCost(x,other);if(cost<best){best=cost;y=other;}}
    if(!y || aa.some(other=>other!==x && componentCost(other,y)<best))continue;
    // Four interior anchors carry scale and prevent a large colored object
    // from shrinking into a point during a long translation.
    const confidence=clamp(.18+Math.sqrt(x.area)*5,.3,2)*(1-best/.55);
    for(const [dx,dy] of [[0,0],[-.30,0],[.30,0],[0,-.30],[0,.30]]) {
      out.push({x:clamp(x.u+dx*x.w),y:clamp(x.v+dy*x.h),tx:clamp(y.u+dx*y.w),ty:clamp(y.v+dy*y.h),w:confidence,r:.11+Math.min(.11,Math.sqrt(x.area)*.36)});
    }
  }
  const ap=patchSamples(a),bp=patchSamples(b),reverse=new Map(),candidates=[];
  for(const x of ap){
    let y=null,best=Infinity;
    for(const q of bp){const cost=featureCost(x,q);if(cost<best){best=cost;y=q;}}
    if(!y || best>1.8)continue;
    if(!reverse.has(y)){
      let winner,lowest=Infinity;
      for(const p of ap){const cost=featureCost(p,y);if(cost<lowest){lowest=cost;winner=p;}}
      reverse.set(y,winner);
    }
    const back=reverse.get(y);
    if(Math.hypot(back.u-x.u,back.v-x.v)>.08)continue;
    candidates.push({x:x.u,y:x.v,tx:y.u,ty:y.v,w:Math.min(1.2,.22+x.strength*.24)/(1+4*best),r:.14});
  }
  for(const c of candidates.sort((x,y)=>y.w-x.w)){
    if(out.some(q=>Math.hypot(q.x-c.x,q.y-c.y)<.087))continue;
    out.push(c);
    if(out.length>=125)break;
  }
  return out;
}

// Integrate a smooth, bounded velocity field. Tracks move with their anchors
// over the integration interval, so long object translations remain possible.
// Envelope constraints keep the photo border intact at both endpoints.
export function correspondence(a,b,cols=33,rows=25,guides=[]) {
  // Artist-authored pairs take priority locally. Automated matches outside
  // their neighborhoods still constrain anatomy, texture and frame edges.
  const guided=guides.filter(q=>[q.x,q.y,q.tx,q.ty].every(Number.isFinite))
    .map(q=>({x:clamp(q.x),y:clamp(q.y),tx:clamp(q.tx),ty:clamp(q.ty),w:32,r:.16}));
  const structure=[];
  for(const {p,q} of lineMatches(a,b)){
    for(let i=0;i<=10;i++){
      const t=i*.115-.075;
      const [x,y]=linePoint(p,t).map(v=>clamp(v,.009,.991)),[tx,ty]=linePoint(q,t).map(v=>clamp(v,.009,.991));
      // Carry a narrow band on either side, giving thin shafts width
      // and preventing adjacent background tracks from shearing the object.
      for(const offset of [-.027,0,.027]){
        const du=p.vertical?offset:0,dv=p.vertical?0:offset;
        structure.push({x:clamp(x+du),y:clamp(y+dv),tx:clamp(tx+du),ty:clamp(ty+dv),w:offset?3:6.5,r:.065});
      }
    }
  }
  const auto=landmarks(a,b).filter(p=>!structure.some(q=>Math.hypot(p.x-q.x,p.y-q.y)<.043 || Math.hypot(p.tx-q.tx,p.ty-q.ty)<.043));
  const eligible=auto.concat(structure).filter(p=>!guided.some(q=>Math.hypot(p.x-q.x,p.y-q.y)<.13 || Math.hypot(p.tx-q.tx,p.ty-q.ty)<.10));
  const tracks=eligible.concat(guided);
  const uv=new Float32Array(cols*rows*2),steps=18;
  for(let j=0;j<rows;j++)for(let i=0;i<cols;i++){
    const k=(j*cols+i)*2;uv[k]=i/(cols-1);uv[k+1]=j/(rows-1);
  }
  for(let s=0;s<steps;s++){
    const t=s/steps;
    const active=tracks.map(q=>({x:mix(q.x,q.tx,t),y:mix(q.y,q.ty,t),dx:q.tx-q.x,dy:q.ty-q.y,w:q.w,r2:q.r*q.r}));
    for(let j=0;j<rows;j++)for(let i=0;i<cols;i++){
      const k=(j*cols+i)*2,x=uv[k],y=uv[k+1];
      let sx=0,sy=0,sw=.09;
      for(const q of active){
        const dist=sq(x-q.x)+sq(y-q.y);
        const ratio=dist/q.r2;
        if(ratio>9)continue;
        const weight=q.w / ((.045+ratio)*(.045+ratio));
        sx+=q.dx*weight;sy+=q.dy*weight;sw+=weight;
      }
      const gx=Math.min(1,6*x,6*(1-x)),gy=Math.min(1,6*y,6*(1-y));
      uv[k]=i===0?0:i===cols-1?1:clamp(x+sx/sw*gx/steps);
      uv[k+1]=j===0?0:j===rows-1?1:clamp(y+sy/sw*gy/steps);
    }
  }
  // Extreme conflicting observations can invert a sampled cell even when
  // the continuous warp is smooth. Repair local crossings by relaxing only
  // the involved nodes, preserving high-confidence features elsewhere.
  const relaxed=new Uint8Array(cols*rows);
  for(let pass=0;pass<24;pass++){
    relaxed.fill(0);let bad=false;
    for(let j=0;j<rows-1;j++)for(let i=0;i<cols-1;i++){
      const p=j*cols+i,q=p+1,r=p+cols,s=r+1;
      const area=(a,b,c)=>(uv[b*2]-uv[a*2])*(uv[c*2+1]-uv[a*2+1])-(uv[b*2+1]-uv[a*2+1])*(uv[c*2]-uv[a*2]);
      if(area(p,q,r)>1e-7 && area(q,s,r)>1e-7)continue;
      bad=true;relaxed[p]=relaxed[q]=relaxed[r]=relaxed[s]=1;
    }
    if(!bad)break;
    for(let j=0;j<rows;j++)for(let i=0;i<cols;i++){
      const k=j*cols+i;if(!relaxed[k])continue;
      const neighbors=[i? k-1:k,i<cols-1?k+1:k,j?k-cols:k,j<rows-1?k+cols:k];
      for(let d=0;d<2;d++){
        if(d===0 && (i===0 || i===cols-1) || d===1 && (j===0 || j===rows-1))continue;
        const avg=neighbors.reduce((sum,n)=>sum+uv[n*2+d],0)/4;
        uv[k*2+d]=mix(uv[k*2+d],avg,.72);
      }
    }
  }
  const flow={cols,rows,uv,tracks:tracks.length};
  // Repair under-shoot after the coarse Jacobian relaxation. Compose small
  // local translations in the already-warped target plane, so neighboring
  // geometry follows each authored control smoothly into its final position.
  const pos=[0,0],passes=12;
  for(let pass=0;guided.length && pass<passes;pass++){
    const nudges=guided.map(q=>{
      const [x,y]=warp(flow,q.x,q.y,pos);
      return {x,y,dx:q.tx-x,dy:q.ty-y};
    });
    if(nudges.every(q=>q.dx*q.dx+q.dy*q.dy<.000002))break;
    const remaining=passes-pass;
    for(let j=0;j<rows;j++)for(let i=0;i<cols;i++){
      const k=(j*cols+i)*2,x=uv[k],y=uv[k+1];
      let sw=1,sx=0,sy=0;
      for(const q of nudges){
        const ratio=(sq(x-q.x)+sq(y-q.y))/.045;
        if(ratio>=4)continue;
        const w=sq(1-ratio*.25)/sq(.06+ratio);
        sw+=w;sx+=q.dx*w;sy+=q.dy*w;
      }
      const gx=Math.min(1,10*x,10*(1-x)),gy=Math.min(1,10*y,10*(1-y));
      if(i>0 && i<cols-1)uv[k]=clamp(x+sx/sw*gx/remaining);
      if(j>0 && j<rows-1)uv[k+1]=clamp(y+sy/sw*gy/remaining);
    }
  }
  return flow;
}
function warp(flow,u,v,out) {
  const x=u*(flow.cols-1),y=v*(flow.rows-1),i=Math.min(flow.cols-2,Math.floor(x)), j=Math.min(flow.rows-2,Math.floor(y));
  const fx=x-i,fy=y-j,idx=(j*flow.cols+i)*2,stride=flow.cols*2;
  for(let d=0;d<2;d++)out[d]=mix(mix(flow.uv[idx+d],flow.uv[idx+2+d],fx),mix(flow.uv[idx+stride+d],flow.uv[idx+stride+2+d],fx),fy);
  return out;
}

const vertex = `
  attribute vec4 samples;       // source center UV, source and target forward depths
  attribute vec4 targetTop;     // warped UVs at the four corners of this tile
  attribute vec4 targetBottom;
  attribute float face;
  attribute vec4 blockInfo;   // shared coarse tile depths and source/target importance
  attribute vec4 blockUV;
  uniform vec2 cell;
  uniform vec4 slopes;
  uniform float phase, gaussianPass;
  varying vec2 uvA,uvB,centerA,centerB,ellipse;
  varying float sideLight;
  varying vec4 materialUV;
  varying vec2 importance;
  varying vec3 worldHit;
  void main(){
    vec2 corner=position.xy;
    if(gaussianPass>.5)corner=.5+position.xy*.70;
    vec2 src=samples.xy+(corner-.5)*cell;
    vec2 dst=mix(mix(targetTop.xy,targetTop.zw,corner.x),mix(targetBottom.xy,targetBottom.zw,corner.x),corner.y);
    uvA=vec2(src.x,1.-src.y);uvB=vec2(dst.x,1.-dst.y);
    centerA=vec2(samples.x,1.-samples.y);
    vec2 center=(targetTop.xy+targetTop.zw+targetBottom.xy+targetBottom.zw)*.25;
    centerB=vec2(center.x,1.-center.y);
    float t=phase;
    vec2 rayA=(src-.5)*vec2(slopes.x,-slopes.y);
    vec2 rayB=(dst-.5)*vec2(slopes.z,-slopes.w);
    vec2 ray=mix(rayA,rayB,t);
    float depth=exp(mix(log(max(.3,samples.z)),log(max(.3,samples.w)),t));
    float coarse=exp(mix(log(max(.3,blockInfo.x)),log(max(.3,blockInfo.y)),t));
    float arch=4.*t*(1.-t);
    float blockDepth=max(.6,floor(coarse*1.4+.5)/1.4);
    depth=mix(depth,blockDepth,arch*.72);
    materialUV=vec4(blockUV.x,1.-blockUV.y,blockUV.z,1.-blockUV.w);
    importance=blockInfo.zw;
    // Square-edged cells have a real back face and connecting side walls.
    // Surface thickness follows the projected size of a tile in world space.
    float tiling=max(.012,min(cell.x*mix(slopes.x,slopes.z,t),cell.y*mix(slopes.y,slopes.w,t))*depth);
    float z=depth+position.z*tiling*(.8+.60*sin(3.14159*t));
    if(gaussianPass>.5)z-=min(.035,tiling*.11);
    vec3 p=vec3(ray*depth,-z);
    ellipse=position.xy;
    sideLight=face;
    worldHit=(modelMatrix*vec4(p,1.)).xyz;
    gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.);
  }
`;
const fragment = `
  uniform sampler2D photoA,photoB,cutA,cutB;
  uniform float phase,coverage,priority,gaussianPass,voxelMix,gaussianStrength;
  uniform vec2 coarseMip;
  uniform highp sampler3D changedCells;
  uniform vec3 changedOrigin;
  uniform float hasChanges;
  varying vec2 uvA,uvB,centerA,centerB,ellipse;
  varying float sideLight;
  varying vec4 materialUV;
  varying vec2 importance;
  varying vec3 worldHit;

  vec3 toLab(vec3 c){
    vec3 lms=vec3(dot(c,vec3(.412221,.536333,.051446)),dot(c,vec3(.211903,.680700,.107397)),dot(c,vec3(.088302,.281719,.629979)));
    lms=pow(max(lms,vec3(0.)),vec3(1./3.));
    return vec3(dot(lms,vec3(.210454,.793618,-.004072)),dot(lms,vec3(1.978,-2.428592,.450594)),dot(lms,vec3(.025904,.782772,-.808676)));
  }
  vec3 fromLab(vec3 c){
    vec3 lms=vec3(c.x+.396338*c.y+.215804*c.z,c.x-.105561*c.y-.063854*c.z,c.x-.089484*c.y-1.291486*c.z);
    lms=lms*lms*lms;
    return vec3(dot(lms,vec3(4.076742,-3.307712,.230970)),dot(lms,vec3(-1.268438,2.609757,-.341319)),dot(lms,vec3(-.004196,-.703419,1.707615)));
  }
  bool throughEditedCell(){
    if(hasChanges<.5)return false;
    vec3 start=cameraPosition-changedOrigin,delta=worldHit-cameraPosition;
    float range=min(14.,max(7.5,length(delta)+.3));
    vec3 dir=normalize(delta+vec3(1e-9));
    ivec3 index=ivec3(floor(start)),stepDir=ivec3(sign(dir));
    vec3 stepDepth=1./max(abs(dir),vec3(1e-7));
    vec3 next=(mix(fract(start),1.-fract(start),step(vec3(0.),dir)))*stepDepth;
    for(int i=0;i<34;i++){
      if(any(lessThan(index,ivec3(0)))||any(greaterThanEqual(index,ivec3(32))))break;
      if(texelFetch(changedCells,index,0).r>.5)return true;
      float hit=min(next.x,min(next.y,next.z));
      if(hit>range)break;
      if(next.x<=next.y && next.x<=next.z){next.x+=stepDepth.x;index.x+=stepDir.x;}
      else if(next.y<=next.z){next.y+=stepDepth.y;index.y+=stepDir.y;}
      else {next.z+=stepDepth.z;index.z+=stepDir.z;}
    }
    return false;
  }
  void main(){
    if(throughEditedCell())discard;
    float t=phase,arch=4.*t*(1.-t);
    float mask=mix(texture2D(cutA,uvA).r,texture2D(cutB,uvB).r,t);
    if(mask<.5)discard;
    vec2 a=mix(uvA,centerA,voxelMix),b=mix(uvB,centerB,voxelMix);
    vec3 A=texture2D(photoA,a).rgb,B=texture2D(photoB,b).rgb;
    vec3 color;
    if(t<.00001)color=A;
    else if(t>.99999)color=B;
    else{
      // Coarse color follows a perceptual path. Sharper scales transfer at
      // different local phases, avoiding double texture at the middle frame.
      vec3 lowA=toLab(textureLod(photoA,a,coarseMip.x).rgb);
      vec3 lowB=toLab(textureLod(photoB,b,coarseMip.y).rgb);
      vec3 structureA=toLab(A)-lowA,structureB=toLab(B)-lowB;
      // Transfer local contrast and foreground identity in coherent spatial
      // regions. Two unmatched subjects should not both become transparent.
      vec2 middle=mix(a,b,t);
      float field=.46*sin(middle.x*8.5+middle.y*6.)+.36*sin(middle.y*12.-middle.x*5.3)+.18*sin(middle.x*19.);
      float importanceDelta=importance.y-importance.x;
      float localPhase=smoothstep(.33,.67,t+arch*(.41*importanceDelta+.22*field+.16*clamp(3.*(length(structureB)-length(structureA)),-1.,1.)));
      vec3 low=mix(lowA,lowB,t);
      color=fromLab(low+mix(structureA,structureB,localPhase));
      vec3 mineral=mix(texture2D(photoA,materialUV.xy).rgb,texture2D(photoB,materialUV.zw).rgb,localPhase);
      color=mix(color,mineral,arch*arch*mix(.17,.56,voxelMix));
    }
    color=max(color,vec3(0.))*sideLight;
    float alpha=coverage;
    if(gaussianPass>.5){
      float r=dot(ellipse,ellipse);if(r>6.25)discard;
      alpha*=gaussianStrength*exp(-.5*r);
    }
    if(alpha<.004)discard;
    gl_FragDepth=gl_FragCoord.z*(1.-(.075+.00004*gaussianPass)*priority);
    gl_FragColor=vec4(color,alpha);
    #include <colorspace_fragment>
  }
`;

function tileGeometry(gaussian) {
  const geometry=new THREE.InstancedBufferGeometry(),vertices=[],faces=[],indices=[];
  function quad(points,shade){
    const base=vertices.length/3;
    for(const p of points){vertices.push(...p);faces.push(shade);}
    indices.push(base,base+2,base+1,base,base+3,base+2);
  }
  if(gaussian){
    quad([[-2.5,-2.5,0],[2.5,-2.5,0],[2.5,2.5,0],[-2.5,2.5,0]],1);
  }else{
    quad([[0,0,0],[1,0,0],[1,1,0],[0,1,0]],1);
    quad([[0,0,1],[0,0,0],[0,1,0],[0,1,1]],.80);
    quad([[1,0,0],[1,0,1],[1,1,1],[1,1,0]],.72);
    quad([[0,0,1],[1,0,1],[1,0,0],[0,0,0]],.94);
    quad([[0,1,0],[1,1,0],[1,1,1],[0,1,1]],.65);
    quad([[0,0,1],[0,1,1],[1,1,1],[1,0,1]],.76);
  }
  geometry.setAttribute('position',new THREE.Float32BufferAttribute(vertices,3));
  geometry.setAttribute('face',new THREE.Float32BufferAttribute(faces,1));
  geometry.setIndex(indices);
  return geometry;
}

// Keep near-avatar edits in a small GPU volume. Both cube and Gaussian
// fragments yield to a player-placed block or mined tunnel on that ray.
export class MorphEditVolume {
  constructor() {
    this.data=new Uint8Array(32*32*32);
    this.texture=new THREE.Data3DTexture(this.data,32,32,32);
    this.texture.format=THREE.RedFormat;this.texture.minFilter=this.texture.magFilter=THREE.NearestFilter;
    this.texture.unpackAlignment=1;this.texture.needsUpdate=true;
    this.buckets=new Map();this.last='';this.changed=true;
    this.uniforms={changedCells:{value:this.texture},changedOrigin:{value:new THREE.Vector3()},hasChanges:{value:0}};
  }
  mark(x,y,z) {
    const sector=[x>>4,y>>4,z>>4].join(',');
    if(!this.buckets.has(sector))this.buckets.set(sector,new Map());
    this.buckets.get(sector).set([x,y,z].join(','),[x,y,z]);this.changed=true;
  }
  update(eye) {
    if(!this.buckets.size)return;
    const x=Math.floor(eye.x)-16,y=Math.floor(eye.y)-16,z=Math.floor(eye.z)-16;
    const key=[x,y,z].join(',');
    if(!this.changed && this.last===key)return;
    this.changed=false;this.last=key;this.data.fill(0);let any=false;
    for(let cz=z>>4;cz<=(z+31)>>4;cz++)for(let cy=y>>4;cy<=(y+31)>>4;cy++)for(let cx=x>>4;cx<=(x+31)>>4;cx++){
      const cells=this.buckets.get([cx,cy,cz].join(','));if(!cells)continue;
      for(const p of cells.values()){
        const i=p[0]-x,j=p[1]-y,k=p[2]-z;
        if(i<0||j<0||k<0||i>=32||j>=32||k>=32)continue;
        this.data[i+32*(j+32*k)]=255;any=true;
      }
    }
    this.uniforms.hasChanges.value=Number(any);this.uniforms.changedOrigin.value.set(x,y,z);this.texture.needsUpdate=true;
  }
  dispose(){this.texture.dispose();}
}
export function createMorphField(rA,rB,flow,edits) {
  const A=rA.surface,B=rB.surface,frameA=A.frame,frameB=B.frame;
  const aspect=clamp(Math.sqrt(frameA.aspect*frameB.aspect),.38,2.65);
  const size=Math.round(110+51*Math.min(rA.profile.detail??.6,rB.profile.detail??.6));
  const w=Math.max(34,Math.round(size*Math.min(1,aspect))),h=Math.max(34,Math.round(size/Math.max(1,aspect)));
  const count=w*h, samples=new Float32Array(count*4),top=new Float32Array(count*4),bottom=new Float32Array(count*4);
  const lut=new Float32Array((w+1)*(h+1)*2),out=[0,0];
  for(let y=0;y<=h;y++) for(let x=0;x<=w;x++)lut.set(warp(flow,x/w,y/h,out),(y*(w+1)+x)*2);
  // Fixed instance ordering at creation. Use a depth buffer on front faces;
  // overlapping Gaussian footprints have near-identical depths on each face.
  const blockInfo=new Float32Array(count*4),blockUV=new Float32Array(count*4);
  function importance(profile,u,v){
    let importance=.56*sample(profile,u,v)[3];
    for(const box of profile.detections||[]){
      const dx=(u-box.x)/Math.max(.001,box.w),dy=(v-box.y)/Math.max(.001,box.h);
      const edge=Math.min(dx,1-dx,dy,1-dy);
      importance=Math.max(importance,clamp(edge*4+.4)*box.score);
    }
    return importance;
  }
  const records=[];
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const u=(x+.5)/w,v=(y+.5)/h,dst=warp(flow,u,v,out);
    const depthA=A.depthAt(u,v),depthB=B.depthAt(dst[0],dst[1]);
    records.push({x,y,u,v,depthA,depthB});
  }
  records.sort((a,b)=>b.depthA+b.depthB-a.depthA-a.depthB);
  records.forEach((r,i)=>{
    const k=(r.y*(w+1)+r.x)*2,j=k+2*(w+1);
    samples.set([r.u,r.v,r.depthA,r.depthB],i*4);
    const au=Math.min(w-.5,Math.floor(r.x/3)*3+1.5)/w,av=Math.min(h-.5,Math.floor(r.y/3)*3+1.5)/h;
    const [bu,bv]=warp(flow,au,av,out);
    blockUV.set([au,av,bu,bv],i*4);
    blockInfo.set([A.depthAt(au,av),B.depthAt(bu,bv),importance(rA.profile,au,av),importance(rB.profile,bu,bv)],i*4);
    top.set(lut.subarray(k,k+4),i*4);bottom.set(lut.subarray(j,j+4),i*4);
  });
  const group=new THREE.Group();group.name='Matched photo volume';
  const uniforms={
    ...edits.uniforms,
    cell:{value:new THREE.Vector2(1/w,1/h)},
    coarseMip:{value:new THREE.Vector2(...[A,B].map(surface=>{
      const image=surface.texture.image;
      return Math.max(2,Math.log2(Math.max(image?.width||512,image?.height||512)/24));
    }))},
    slopes:{value:new THREE.Vector4(frameA.slopeX,frameA.slopeY,frameB.slopeX,frameB.slopeY)},
    photoA:{value:A.texture},photoB:{value:B.texture},cutA:{value:A.cutouts},cutB:{value:B.cutouts},
    phase:{value:0},coverage:{value:1},priority:{value:1},voxelMix:{value:0},gaussianStrength:{value:.3}
  };
  const materials=[];
  for(const gaussian of [false,true]){
    const geometry=tileGeometry(gaussian);
    for(const [name,array] of [['samples',samples],['targetTop',top],['targetBottom',bottom],['blockInfo',blockInfo],['blockUV',blockUV]])
      geometry.setAttribute(name,new THREE.InstancedBufferAttribute(array,4));
    geometry.instanceCount=count;
    const material=new THREE.ShaderMaterial({ uniforms:{...uniforms,gaussianPass:{value:Number(gaussian)}},vertexShader:vertex,fragmentShader:fragment,
      side:THREE.DoubleSide,transparent:true,forceSinglePass:true,depthTest:true,depthWrite:!gaussian,toneMapped:false
    });
    const mesh=new THREE.Mesh(geometry,material);mesh.frustumCulled=false;mesh.renderOrder=gaussian?42:41;
    group.add(mesh);materials.push(material);
  }
  function update(t,weight,mode,splats,displacement){
    const a=frameA.anchor,b=frameB.anchor;
    const yawA=Math.atan2(a.dx,-a.dz),yawB=Math.atan2(b.dx,-b.dz);
    const yaw=yawA+Math.atan2(Math.sin(yawB-yawA),Math.cos(yawB-yawA))*t;
    group.position.set(mix(a.x,b.x,t),mix(frameA.eyeY,frameB.eyeY,t),mix(a.z,b.z,t));
    group.rotation.y=-yaw;
    group.visible=weight>.003;
    uniforms.phase.value=t;uniforms.coverage.value=weight;
    uniforms.priority.value=1-THREE.MathUtils.smoothstep(displacement,.55,6.5);
    uniforms.voxelMix.value=mode==='voxel'?.88:mode==='hybrid'?Math.min(.95,1-clamp(splats/.55)+.13*Math.sin(Math.PI*t)):0;
    uniforms.gaussianStrength.value=mode==='splat'?Math.min(1,splats*1.6):splats*.30;
    group.children[0].visible=mode!=='splat';
    group.children[1].visible=mode!=='voxel'&&splats>0;
    materials[0].depthWrite=weight>.97;
  }
  return {mesh:group,update,count,tracks:flow.tracks,dispose(){
    for(const mesh of group.children){mesh.geometry.dispose();mesh.material.dispose();}
  }};
}
