const $ = id => document.getElementById(id);
const clamp = t => Math.max(0,Math.min(1,t));

export function pathControls({records,getGame,isPlaying,save}) {
  let target = null, fraction = 0, shown = false, animation = 0, previousPair = '';
  const dock = $('path-dock'), slider = $('path-position');
  const previewLabel = $('path-preview').querySelector('span');
  const names = (a,b) => a.title+' → '+b.title;

  function stop() {
    cancelAnimationFrame(animation);
    animation = 0;
    previewLabel.textContent = 'Preview walk';
  }
  function draw(from,to,t) {
    const a = records[from], b = records[to];
    if (!a || !b) return;
    const key = from+'/'+to;
    if (key !== previousPair) {
      previousPair = key;
      for (const [button,r] of [[$('path-start'),a],[$('path-end'),b]]) {
        button.querySelector('img').src = r.thumb;
        button.querySelector('span').textContent = r.title;
        button.title = 'Stand at the source view for '+r.title;
      }
      $('walk-pair').textContent = names(a,b);
    }
    const pct = Math.round(t*100)+'%';
    slider.value = Math.round(t*1000);
    slider.style.setProperty('--p',pct);
    slider.setAttribute('aria-valuetext',pct+' between '+names(a,b));
    $('path-percent').textContent = $('walk-percent').textContent = pct;
    $('walk-progress').querySelector('.walk-track span').style.width = pct;
  }
  function seek(t) {
    const b = records[target];
    if (!b) return false;
    fraction = clamp(t);
    const ok = getGame().frameMorph(target,fraction);
    if (ok === false) return false;
    draw(b.anchor.from ?? target-1,target,fraction);
    return true;
  }
  function hide() {
    stop(); shown=false;dock.hidden=true;
    document.body.classList.remove('path-open');
  }
  function show(index,t=0) {
    if (!records[index] || index <= 0) return;
    stop();target=index;shown=true;dock.hidden=false;
    document.body.classList.add('path-open');
    getGame().pause();seek(t);
  }
  function resume(route) {
    if (!route || !records[route.from] || !records[route.to]) return;
    stop();target=route.to;fraction=clamp(route.t);shown=true;dock.hidden=false;
    document.body.classList.add('path-open');
    draw(route.from,route.to,fraction);
  }
  function preview() {
    if (animation) { stop();save();return; }
    if (target === null) return;
    if (fraction > .985) seek(0);
    const start = fraction, time = performance.now();
    previewLabel.textContent = 'Pause preview';
    function step(now) {
      const t = clamp(start + (now-time)/7800);
      seek(t);
      if (t < 1) animation=requestAnimationFrame(step);
      else {stop();save();}
    }
    animation=requestAnimationFrame(step);
  }
  function observe(stats) {
    const route=stats.morph;
    $('walk-progress').hidden=!isPlaying() || !route;
    if (!route || !records[route.to] || !records[route.from]) return;
    if (isPlaying() || (shown && target===route.to)) {
      target=route.to;fraction=clamp(route.t);draw(route.from,route.to,fraction);
    }
  }
  $('path-close').onclick=()=>{hide();save();};
  $('path-preview').onclick=preview;
  $('path-walk').onclick=()=>{stop();seek(fraction >= .985 ? 0 : fraction);getGame().play();};
  $('path-start').onclick=()=>{stop();seek(0);save();};
  $('path-end').onclick=()=>{stop();seek(1);save();};
  slider.oninput=()=>{stop();seek(+slider.value/1000);};
  slider.onchange=save;
  window.addEventListener('keydown',e=>{
    if (!animation || !['KeyW','KeyS','ArrowUp','ArrowDown'].includes(e.code) || document.querySelector('dialog[open]')) return;
    stop();getGame().play();getGame().moveKey(e.code,true);e.preventDefault();
  });
  document.addEventListener('visibilitychange',()=>{if(document.hidden && animation){stop();save();}});
  return {show,resume,hide,stop,preview,observe, get target(){return target;}, get shown(){return shown;}};
}
