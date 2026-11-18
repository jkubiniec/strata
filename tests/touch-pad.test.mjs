import assert from 'node:assert/strict';
import test from 'node:test';
import { Game } from '../dist/game.js';
import { bindTouchPad } from '../dist/touch-pad.js';

function surface() {
  const handlers = new Map();
  return {
    addEventListener(type, fn) { handlers.set(type, fn); },
    fire(type, event) { handlers.get(type)(event); }
  };
}

function setup() {
  const pad = surface(), win = surface();
  const buttons = ['KeyW', 'KeyA', 'Space'].map(key => {
    const held = new Set();
    return {
      dataset: {key},
      closest(selector) { return selector === '.dpad' && key === 'Space' ? null : this; },
      classList: {add: cls => held.add(cls), remove: cls => held.delete(cls), contains: cls => held.has(cls)},
      setPointerCapture() {}
    };
  });
  pad.contains = node => buttons.includes(node);
  pad.ownerDocument = {defaultView: win, elementFromPoint: x => buttons[x] ?? null};
  const game = Object.assign(Object.create(Game.prototype), {
    playing: true, keys: new Set(), keyOwners: new Map(), useLiveViewport() {}
  });
  const clear = bindTouchPad(pad, game.moveKey.bind(game));
  const down = (id, index) => pad.fire('pointerdown', {
    target: buttons[index], button: 0, pointerId: id, pointerType: 'touch', preventDefault() {}
  });
  const move = (id, index) => win.fire('pointermove', {pointerId: id, clientX: index, clientY: 0, pointerType: 'touch'});
  return {pad, win, game, buttons, down, move, clear};
}

test('the thumb steers across arrows, stops outside them and stops on lift even without capture', () => {
  const {win, game, buttons, down, move} = setup();
  buttons[0].setPointerCapture = () => { throw new Error('capture unavailable'); };
  down(8, 0);
  assert.deepEqual([...game.keys], ['KeyW']);
  move(8, 1);
  assert.deepEqual([...game.keys], ['KeyA']);
  assert.equal(buttons[0].classList.contains('held'), false);
  move(8, 2); // Passing over jump while steering must not trigger a jump.
  assert.equal(game.keys.size, 0);
  move(8, 1);
  move(8, -1);
  assert.equal(game.keys.size, 0);
  move(8, 0);
  win.fire('pointerup', {pointerId: 8});
  move(8, 1);
  assert.equal(game.keys.size, 0);
});

test('each finger and the keyboard retain independent ownership through releases and interruptions', () => {
  const {pad, win, game, buttons, down, move, clear} = setup();
  game.moveKey('KeyW', true);
  down(8, 0);
  down(9, 0);
  win.fire('pointercancel', {pointerId: 8});
  assert.ok(buttons[0].classList.contains('held'));
  move(9, 1);
  assert.deepEqual([...game.keys], ['KeyW', 'KeyA']);
  pad.fire('lostpointercapture', {pointerId: 9, target: buttons[0]});
  assert.deepEqual([...game.keys], ['KeyW']);
  down(10, 1);
  win.fire('touchend', {touches: [{target: null}]}); // Only the look finger remains.
  assert.deepEqual([...game.keys], ['KeyW']);
  down(11, 1);
  win.fire('orientationchange', {});
  assert.deepEqual([...game.keys], ['KeyW']);
  down(12, 1);
  clear(); // Pause or leave the page while the finger is down.
  move(11, 0);
  assert.deepEqual([...game.keys], ['KeyW']);
  assert.equal(buttons[0].classList.contains('held'), false);
  assert.equal(buttons[1].classList.contains('held'), false);
  game.moveKey('KeyW', false);
  assert.equal(game.keys.size, 0);
});
