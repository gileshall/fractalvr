// Turns XR gamepads and desktop keys into one per-frame intent object.
//
// Roles: left trigger uses the tool, right trigger opens the quick menu (tools and their
// settings among its pages), left grip holds the fractal, right grip sculpts it, the left
// stick pressed in is the colour knob. Sticks fly; the layout decides which axis
// does what (standard or heli mode 2). A and B on the right hand zoom; together, cruise.

import { state } from './state.js';

const DEAD = 0.15;
const LATCH_LEAD = 250; // ms one zoom button is held before the other for its way to be the cruise's

function curve(v) {
  if (Math.abs(v) < DEAD) return 0;
  const s = Math.sign(v);
  const m = (Math.abs(v) - DEAD) / (1 - DEAD);
  return s * m * m; // quadratic for fine control near centre
}

export class ButtonState {
  constructor() { this.pressed = false; this.down = false; this.up = false; this.at = 0; this.value = 0; }
  // value: how far in an analogue button is, 0 to 1.
  set(p, value = p ? 1 : 0) {
    this.down = p && !this.pressed; this.up = !p && this.pressed; this.pressed = p;
    this.value = value;
    if (this.down) this.at = performance.now();
  }
  // Drop the state without producing an edge (a vanished hand must not fire a release).
  reset() { this.pressed = false; this.down = false; this.up = false; this.value = 0; }
}

export class Input {
  constructor(renderer, hands) {
    this.renderer = renderer;
    this.hands = hands;
    this.buttons = {};
    for (const h of ['left', 'right']) {
      this.buttons[h] = { trigger: new ButtonState(), grip: new ButtonState(), stick: new ButtonState(), a: new ButtonState(), b: new ButtonState() };
    }
    this.actuators = { left: null, right: null };
    this.keys = new Set();
    this.keyEdges = new Set();
    addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      this.keyEdges.add(e.code);
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    this.wheel = 0;
    addEventListener('wheel', (e) => { this.wheel += e.deltaY; }, { passive: true });
  }

  // A tick in the hand: strength 0 to 1, for so many ms. A hand with nothing to shake is left be.
  pulse(hand, strength, ms) {
    const a = this.actuators[hand];
    if (a) a.pulse(strength, ms).catch((e) => console.error('haptic pulse', e));
  }

  poll() {
    const b = this.buttons;
    const intent = {
      fly: [0, 0], climb: 0, turn: 0, zoom: 0, boost: false,
      menu: false, recenter: false, report: false, nextFractal: false, prevFractal: false, nextPalette: false,
      latch: false, latchDir: 0, // cruise on or off; the way to set off, 0 for as it last went
      tour: false, // tour on or off
      toolPick: 0, // desktop: 1-based tool index pressed this frame
      axes: { left: [0, 0], right: [0, 0] },
      trigger: { left: b.left.trigger, right: b.right.trigger },
      grip: { left: b.left.grip, right: b.right.grip },
      stick: { left: b.left.stick, right: b.right.stick },
      a: { left: b.left.a, right: b.right.a },
      b: { left: b.left.b, right: b.right.b },
      xr: false,
    };

    const session = this.renderer.xr.getSession();
    const seen = { left: false, right: false };
    if (session) {
      intent.xr = true;
      for (const src of session.inputSources) {
        const gp = src.gamepad;
        const hand = src.handedness;
        if (!gp || (hand !== 'left' && hand !== 'right')) continue;
        // A tracked hand has no stick: its pinch is not a trigger, and it flies nothing.
        if (gp.axes.length < 2) continue;
        seen[hand] = true;
        this.actuators[hand] = gp.hapticActuators ? gp.hapticActuators[0] : null;
        const s = b[hand];
        const P = (i) => gp.buttons[i] !== undefined && gp.buttons[i].pressed;
        s.trigger.set(P(0), gp.buttons[0] !== undefined ? gp.buttons[0].value : 0);
        s.grip.set(P(1));
        s.stick.set(P(3));
        s.a.set(P(4));
        s.b.set(P(5));
        const ax = curve(gp.axes.length >= 4 ? gp.axes[2] : gp.axes[0]);
        const ay = curve(gp.axes.length >= 4 ? gp.axes[3] : gp.axes[1]);
        intent.axes[hand] = [ax, -ay];
      }
      const L = intent.axes.left, R = intent.axes.right;
      if (state.controls === 'heli') {
        intent.climb = L[1];
        intent.turn = L[0];
        intent.fly = [R[0], R[1]];
      } else {
        intent.fly = [L[0], L[1]];
        intent.turn = R[0];
        intent.zoom = R[1];
      }
      // A and B together: cruise. One of them held a while before the other is the way to go,
      // else the stick's where it is pushed.
      const A = b.right.a, B = b.right.b;
      if ((A.down && B.pressed) || (B.down && A.pressed)) {
        intent.latch = true;
        const lead = A.down && B.down ? 0 : performance.now() - (A.down ? B.at : A.at);
        if (lead >= LATCH_LEAD) intent.latchDir = A.down ? -1 : 1;
        else if (Math.abs(intent.zoom) >= 0.5) intent.latchDir = Math.sign(intent.zoom);
      }
      intent.zoom += (A.pressed ? 1 : 0) - (B.pressed ? 1 : 0);
      intent.boost = b.right.stick.pressed;
      if (b.left.b.down) intent.menu = true;
      if (b.left.a.down) intent.recenter = true;
    }

    // Hands that vanished (system menu, disconnect) release everything so no edge fires later.
    for (const h of ['left', 'right']) {
      if (!seen[h] && session) for (const s of Object.values(b[h])) s.reset();
      if (!seen[h]) this.actuators[h] = null;
    }

    // Desktop
    const k = this.keys;
    const K = (c) => k.has(c);
    const E = (c) => this.keyEdges.has(c);
    if (K('KeyW')) intent.fly[1] += 1;
    if (K('KeyS')) intent.fly[1] -= 1;
    if (K('KeyD')) intent.fly[0] += 1;
    if (K('KeyA')) intent.fly[0] -= 1;
    if (K('KeyE')) intent.climb += 1;
    if (K('KeyQ')) intent.climb -= 1;
    if (K('KeyZ')) intent.zoom += 1;
    if (K('KeyX')) intent.zoom -= 1;
    if (K('ArrowLeft')) intent.turn -= 1;
    if (K('ArrowRight')) intent.turn += 1;
    if (this.wheel) { intent.zoom += -Math.sign(this.wheel) * 0.6; this.wheel = 0; }
    intent.boost = intent.boost || K('ShiftLeft') || K('ShiftRight');
    if (E('Tab')) intent.menu = true;
    if (E('KeyR')) intent.recenter = true;
    if (E('KeyM')) intent.report = true;
    if (E('KeyN')) intent.nextFractal = true;
    if (E('KeyP')) intent.prevFractal = true;
    if (E('KeyC')) intent.nextPalette = true;
    if (E('KeyF')) { intent.latch = true; intent.latchDir = Math.sign(intent.zoom); }
    if (E('KeyO')) intent.tour = true;
    for (let i = 1; i <= 9; i++) if (E(`Digit${i}`)) intent.toolPick = i;
    if (!session) {
      // T/Y front triggers, G/H grips, V the left stick pressed in, arrows up/down and I/K/J/L stand in for the sticks.
      b.left.trigger.set(K('KeyT'));
      b.right.trigger.set(K('KeyY'));
      b.left.grip.set(K('KeyG'));
      b.right.grip.set(K('KeyH'));
      b.left.stick.set(K('KeyV'));
      intent.axes.left = [(K('KeyL') ? 1 : 0) - (K('KeyJ') ? 1 : 0), (K('KeyI') ? 1 : 0) - (K('KeyK') ? 1 : 0)];
      intent.axes.right = [(K('ArrowRight') ? 1 : 0) - (K('ArrowLeft') ? 1 : 0), (K('ArrowUp') ? 1 : 0) - (K('ArrowDown') ? 1 : 0)];
    }
    this.keyEdges.clear();
    return intent;
  }
}
