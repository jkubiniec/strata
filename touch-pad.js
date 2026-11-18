// Capture keeps a drag alive outside the pad. Hit-test the thumb's physical
// location because captured events keep reporting the original button as target.
export function bindTouchPad(pad, moveKey) {
  const contacts = new Map();
  const doc = pad.ownerDocument, win = doc.defaultView;
  const controlAt = target => {
    const button = target?.closest?.('button[data-key]');
    return button && pad.contains(button) ? button : null;
  };

  function select(id, button) {
    const contact = contacts.get(id);
    if (!contact || contact.button === button) return;
    const previous = contact.button;
    contact.button = button;
    if (previous) {
      moveKey(previous.dataset.key, false, id);
      if (![...contacts.values()].some(other => other.button === previous)) previous.classList.remove('held');
    }
    if (button) {
      moveKey(button.dataset.key, true, id);
      button.classList.add('held');
    }
  }
  function end(id) {
    select(id, null);
    contacts.delete(id);
  }
  function clear() {
    for (const id of contacts.keys()) end(id);
  }

  pad.addEventListener('pointerdown', event => {
    const origin = controlAt(event.target);
    if (!origin || event.button !== 0 || contacts.has(event.pointerId)) return;
    event.preventDefault();
    contacts.set(event.pointerId, {origin, button:null, type:event.pointerType});
    select(event.pointerId, origin);
    try { origin.setPointerCapture(event.pointerId); } catch { /* Window listeners still follow the contact. */ }
  });
  win.addEventListener('pointermove', event => {
    const contact = contacts.get(event.pointerId);
    if (!contact) return;
    if (event.pointerType !== 'touch' && event.buttons === 0) { end(event.pointerId); return; }
    const hit = controlAt(doc.elementFromPoint(event.clientX, event.clientY));
    // Sliding between arrows steers. Jump stays a separate action.
    const valid = hit && (hit === contact.origin || (hit.closest('.dpad') && contact.origin.closest('.dpad')));
    select(event.pointerId, valid ? hit : null);
  }, true);
  for (const type of ['pointerup', 'pointercancel']) {
    win.addEventListener(type, event => end(event.pointerId), true);
  }
  pad.addEventListener('lostpointercapture', event => {
    if (contacts.get(event.pointerId)?.origin === event.target) end(event.pointerId);
  });

  // Safari can interrupt a pointer stream during a system gesture. A touch
  // retains its starting element, even after sliding or changing direction.
  const reconcile = event => {
    const stillDown = new Set(Array.from(event.touches, touch => controlAt(touch.target)));
    for (const [id, contact] of contacts) {
      if (contact.type === 'touch' && !stillDown.has(contact.origin)) end(id);
    }
  };
  for (const type of ['touchend', 'touchcancel']) {
    win.addEventListener(type, reconcile, {capture:true, passive:true});
  }
  return clear;
}
