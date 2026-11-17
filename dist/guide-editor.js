const clamp = n => Math.max(.001, Math.min(.999, n));

// All marker positions use the complete, uncropped photo and top-left origin.
export function editGuides(body, source, target, onApply) {
  body.classList.add('guide-editor');
  const pairs = (target.anchor.guides || []).map(p => ({...p}));
  const photos = [source, target];
  const cursors = [{x:.5,y:.5}, {x:.5,y:.5}];
  let pending = null;
  const text = document.createElement('p');
  text.textContent = 'Pick a detail in the first photo, then pick what it should become in the second.';
  const layout = document.createElement('div');
  layout.className = 'guide-images';
  const status = document.createElement('p');
  status.className = 'guide-status';
  status.setAttribute('role','status');
  const undo = document.createElement('button');
  undo.className = 'guide-undo';
  undo.textContent = 'Undo last point';
  const apply = document.createElement('button');
  apply.className = 'primary';
  apply.textContent = 'Apply to path';
  const toolbar = document.createElement('div');
  toolbar.className = 'guide-toolbar';
  toolbar.append(undo, apply);
  const frames = photos.map((r, side) => {
    const figure = document.createElement('figure');
    const label = document.createElement('figcaption');
    label.textContent = r.title;
    const frame = document.createElement('button');
    frame.className = 'guide-photo';
    frame.setAttribute('aria-label', 'Choose a point on '+r.title+'. Arrow keys move the marker. Enter places it.');
    frame.title = 'Click a detail, or use the arrow keys and Enter';
    const image = document.createElement('img');
    image.src = r.thumb;
    image.alt = '';
    image.draggable = false;
    const marks = document.createElement('span');
    marks.className = 'guide-marks';
    marks.setAttribute('aria-hidden','true');
    const cursor = document.createElement('span');
    cursor.className = 'guide-cursor';
    frame.append(image, marks, cursor);
    figure.append(label,frame);
    layout.append(figure);
    frame.addEventListener('keydown', event => {
      const delta = {ArrowLeft:[-1,0], ArrowRight:[1,0], ArrowUp:[0,-1], ArrowDown:[0,1]}[event.key];
      if (!delta) return;
      event.preventDefault();
      const c = cursors[side], step = event.shiftKey ? .06 : .01;
      c.x = clamp(c.x+delta[0]*step);
      c.y = clamp(c.y+delta[1]*step);
      cursor.style.left = c.x*100+'%';
      cursor.style.top = c.y*100+'%';
    });
    frame.onclick = event => {
      const rect = frame.getBoundingClientRect();
      const spot = event.detail ? {x:clamp((event.clientX-rect.left)/rect.width),y:clamp((event.clientY-rect.top)/rect.height)} : {...cursors[side]};
      if (side === 0) pending = spot;
      else if (pending) {
        pairs.push({...pending, tx:spot.x, ty:spot.y});
        pending = null;
      } else {
        status.textContent = 'Choose the detail in '+source.title+' first.';
        frames[0].frame.focus({preventScroll:true});
        return;
      }
      draw();
      if (!event.detail) frames[side ? 0 : 1].frame.focus({preventScroll:true});
    };
    return {frame,marks};
  });

  function pin(x,y,index) {
    const el = document.createElement('span');
    el.className = 'guide-pin';
    el.style.left = x*100+'%';
    el.style.top = y*100+'%';
    el.textContent = String(index+1);
    return el;
  }
  function draw() {
    frames[0].marks.replaceChildren(...pairs.map((p,i) => pin(p.x,p.y,i)));
    frames[1].marks.replaceChildren(...pairs.map((p,i) => pin(p.tx,p.ty,i)));
    if (pending) frames[0].marks.append(pin(pending.x,pending.y,pairs.length));
    frames.forEach(({frame},i) => frame.classList.toggle('expect-point', i === Number(!!pending)));
    undo.disabled = !pending && !pairs.length;
    apply.disabled = !!pending;
    status.textContent = pending ? 'Choose the matching detail in '+target.title+'.' :
      pairs.length ? pairs.length+' matched '+(pairs.length===1?'pair':'pairs')+' · Choose another detail or apply.' : 'Automatic matches are active.';
  }
  undo.onclick = () => { if (pending) pending=null; else pairs.pop(); draw(); };
  apply.onclick = () => onApply(pairs);
  body.append(text,layout,status,toolbar);
  draw();
}
