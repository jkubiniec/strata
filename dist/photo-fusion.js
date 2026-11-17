// Blend broad illumination across all contributing images. Higher-frequency
// material follows the most informative registered observations at this point.
const bands=new WeakMap();
const bound=(n,lo,hi)=>Math.max(lo,Math.min(hi,n));

function downsample(image,size) {
  const ratio=Math.min(1,size/Math.max(image.width,image.height));
  const w=Math.max(1,Math.round(image.width*ratio)),h=Math.max(1,Math.round(image.height*ratio));
  const data=new Float32Array(w*h*3),samples=new Uint32Array(w*h);
  const stride=Math.max(1,Math.floor(Math.max(image.width,image.height)/430));
  for(let y=0;y<image.height;y+=stride)for(let x=0;x<image.width;x+=stride){
    const k=Math.floor(x*w/image.width)+w*Math.floor(y*h/image.height),from=image.stride*(x+y*image.width);
    samples[k]++;
    for(let c=0;c<3;c++)data[k*3+c]+=image.data[from+c];
  }
  for(let k=0;k<samples.length;k++)for(let c=0;c<3;c++)data[k*3+c]/=Math.max(1,samples[k]);
  return {data,w,h};
}
function photoBands(image) {
  if(!bands.has(image))bands.set(image,[downsample(image,12),downsample(image,64)]);
  return bands.get(image);
}
function readBand(level,u,v,out,offset){
  const x=bound(u*level.w-.5,0,level.w-1),y=bound(v*level.h-.5,0,level.h-1);
  const i=Math.floor(x),j=Math.floor(y),a=x-i,b=y-j;
  const p=(j*level.w+i)*3,q=i+1<level.w?p+3:p,r=j+1<level.h?p+3*level.w:p,s=r+(q-p);
  for(let c=0;c<3;c++){
    out[offset+c]=(level.data[p+c]*(1-a)+level.data[q+c]*a)*(1-b)+(level.data[r+c]*(1-a)+level.data[s+c]*a)*b;
  }
}
// Resample the source UV maps with premultiplied confidence. A missing corner
// of a clipped capture must not pull another photograph's UV toward (0,0).
export function fuseAppearance(record,grid){
  const size=Math.min(1410,Math.max(320,Math.round(Math.max(record.source.width*record.cropX,record.source.height*record.cropY))));
  const width=Math.max(1,Math.round(size*Math.min(1,record.s.aspect))),height=Math.max(1,Math.round(size/Math.max(1,record.s.aspect)));
  const data=new Uint8Array(width*height*4), row=grid.w+1, row3=row*3;
  const xs=Float32Array.from({length:width},(_,i)=>(i+.5)*grid.w/width);
  const sources=grid.neighbors.map(n=>n.source);
  const levels=sources.length>1?sources.map(photoBands):null;
  const tone=new Float64Array(6),sum=new Float64Array(9);
  for(let j=0;j<height;j++){
    const fy=(j+.5)*grid.h/height,iy=Math.floor(fy),b=fy-iy;
    for(let i=0;i<width;i++){
      const fx=xs[i],ix=Math.floor(fx),a=fx-ix,base=(ix+row*iy)*3;
      const w00=(1-a)*(1-b),w10=a*(1-b),w01=(1-a)*b,w11=a*b;
      sum.fill(0);
      let total=0,midSum=0,highSum=0,maxWeight=0,count=0,lastPixel=0,lastSource;
      for(let k=0;k<sources.length;k++){
        const m=grid.maps[k],image=sources[k];
        const q0=m[base+2]*w00,q1=m[base+5]*w10,q2=m[base+row3+2]*w01,q3=m[base+row3+5]*w11;
        const t=q0+q1+q2+q3;
        if(t<.000003)continue;
        const u=(m[base]*q0+m[base+3]*q1+m[base+row3]*q2+m[base+row3+3]*q3)/t;
        const v=(m[base+1]*q0+m[base+4]*q1+m[base+row3+1]*q2+m[base+row3+4]*q3)/t;
        const pixel=(bound(Math.floor(u*image.width),0,image.width-1)+image.width*bound(Math.floor(v*image.height),0,image.height-1))*image.stride;
        count++;total+=t;maxWeight=Math.max(t,maxWeight);lastPixel=pixel;lastSource=image.data;
        if(!levels)continue;
        readBand(levels[k][0],u,v,tone,0);readBand(levels[k][1],u,v,tone,3);
        let mediumEnergy=0,fineEnergy=0;
        for(let c=0;c<3;c++){mediumEnergy+=Math.abs(tone[3+c]-tone[c]);fineEnergy+=Math.abs(lastSource[pixel+c]-tone[3+c]);}
        const structure=.48+Math.min(2.15,mediumEnergy/100);
        const mw=t*t*t*structure*structure,hw=mw*(.78+Math.min(1.8,fineEnergy/130));
        midSum+=mw;highSum+=hw;
        for(let c=0;c<3;c++){
          sum[c]+=tone[c]*t;
          sum[3+c]+=(tone[3+c]-tone[c])*mw;
          sum[6+c]+=(lastSource[pixel+c]-tone[3+c])*hw;
        }
      }
      const dest=(j*width+i)*4;
      if(count===1){
        for(let c=0;c<3;c++)data[dest+c]=lastSource[lastPixel+c];
      }else if(count>1){
        for(let c=0;c<3;c++)data[dest+c]=bound(Math.round(sum[c]/total+sum[3+c]/midSum+sum[6+c]/highSum),0,255);
        data[dest+3]=Math.round(255*Math.min(1,2*(1-maxWeight/total)));
      }
    }
  }
  return {width,height,data,stride:4};
}
