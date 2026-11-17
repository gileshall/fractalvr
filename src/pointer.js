import * as THREE from 'three';
import { Steady } from './steady.js';

// Controller rays (and the desktop mouse) driving the canvas panels, plus window dragging:
// trigger on a title bar or grip anywhere holds the window on the ray at a fixed distance,
// always facing the head. A hand's point on a window is steadied through a trigger pull.

const UP = new THREE.Vector3(0, 1, 0);
const FORWARD = new THREE.Vector3(0, 0, -1);
const STRAY = 0.045; // of the distance to a window: how far a ray may go in a pull and be held

export class Pointers {
  constructor({ rig, hands, panels, domElement }) {
    this.rig = rig;
    this.hands = hands;
    this.panels = panels;
    this.raycaster = new THREE.Raycaster();
    this.hover = { left: null, right: null, mouse: null }; // the ray's own hit
    this.aim = { left: null, right: null, mouse: null }; // { panel, x, y }: the point used, on a window
    this.off = { left: Infinity, right: Infinity }; // metres the ray passes outside the nearest window
    this.steady = { left: new Steady(), right: new Steady() };
    this.on = { left: null, right: null, mouse: null }; // the window a pointer is on
    this.log = null; // (kind, data): what was pressed, for telemetry
    this.onPress = null; // (hand): a press that did something
    this.onMoved = null; // (panel): a window was put down
    this.drag = { left: null, right: null, mouse: null }; // { panel, dist, offset, button }
    this.lines = {};
    for (const h of ['left', 'right']) {
      const geom = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]);
      const line = new THREE.Line(geom, new THREE.LineBasicMaterial({ color: 0x9fb4ff, depthTest: true, depthFunc: THREE.AlwaysDepth, depthWrite: true }));
      line.renderOrder = -0.4;
      line.visible = false;
      this.lines[h] = line;
    }

    for (const p of panels) p.mesh.userData.panel = p;
    this._hits = [];
    this._meshes = [];
    this._plane = new THREE.Plane();
    this._q = new THREE.Quaternion();
    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._n = new THREE.Vector3();
    this._pt = new THREE.Vector3();
    this._m = new THREE.Matrix4();
    this.mouseNdc = null;
    this.mouseDown = false;
    domElement.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement) { this.mouseNdc = null; return; }
      this.mouseNdc = new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    });
    domElement.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      this.mouseNdc = new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
      this.mouseDown = true;
      this.pendingDown = true;
    });
    addEventListener('mouseup', (e) => { if (e.button === 0) this.mouseDown = false; });
    this.mouseWasDown = false;
    this.pendingDown = false;
  }

  visiblePanels() {
    this._meshes.length = 0;
    for (const p of this.panels) if (p.mesh.visible) this._meshes.push(p.mesh);
    return this._meshes;
  }

  // True when the mouse is over a visible panel (so pointer lock should not engage).
  mouseOnPanel(camera) {
    if (!this.mouseNdc) return false;
    this.raycaster.setFromCamera(this.mouseNdc, camera);
    this._hits.length = 0;
    return this.raycaster.intersectObjects(this.visiblePanels(), false, this._hits).length > 0;
  }

  busy(hand) {
    if (this.aim[hand] || this.drag[hand]) return true;
    for (const p of this.panels) if (p.captures.has(hand)) return true;
    return false;
  }

  update(intent, camera, dt) {
    const meshes = this.visiblePanels();
    for (const hand of ['left', 'right']) {
      const line = this.lines[hand];
      const ray = this.hands[hand].ray;
      if (line.parent !== ray) ray.add(line);
      if (!intent.xr || meshes.length === 0) {
        line.visible = false;
        this.leave(hand);
        this.off[hand] = Infinity;
        continue;
      }
      ray.getWorldPosition(this.raycaster.ray.origin);
      ray.getWorldDirection(this.raycaster.ray.direction).negate();
      this.dispatch(hand, meshes, intent.trigger[hand], intent.grip[hand], dt);
      this.off[hand] = this.aim[hand] || this.drag[hand] ? 0 : this.outside();
      line.visible = true;
      const aim = this.aim[hand];
      const drag = this.drag[hand];
      // The line ends on the point used. Its units are the ray object's: room metres.
      line.quaternion.identity();
      line.scale.z = drag ? drag.dist : 0.25;
      if (aim && !drag) {
        const to = ray.worldToLocal(aim.panel.mesh.localToWorld(this._v.set((aim.x / aim.panel.canvas.width - 0.5) * aim.panel.meters, (0.5 - aim.y / aim.panel.canvas.height) * aim.panel.metersH, 0)));
        line.scale.z = to.length();
        line.quaternion.setFromUnitVectors(FORWARD, to.normalize());
      }
    }
    if (this.mouseNdc && meshes.length) {
      this.raycaster.setFromCamera(this.mouseNdc, camera);
      const down = this.pendingDown;
      this.pendingDown = false;
      const pressed = this.mouseDown || down;
      const btn = { pressed, down, up: !this.mouseDown && (this.mouseWasDown || down), value: pressed ? 1 : 0 };
      this.mouseWasDown = this.mouseDown;
      this.dispatch('mouse', meshes, btn, null, dt);
    } else {
      this.leave('mouse');
    }
  }

  // Where the ray meets a window's plane, in its canvas pixels (on the window or off it).
  onPlane(panel) {
    this._n.set(0, 0, 1).applyQuaternion(panel.mesh.getWorldQuaternion(this._q));
    this._plane.setFromNormalAndCoplanarPoint(this._n, panel.mesh.getWorldPosition(this._v));
    const pt = this.raycaster.ray.intersectPlane(this._plane, this._pt);
    if (!pt) return null;
    panel.mesh.worldToLocal(pt);
    return [(pt.x / panel.meters + 0.5) * panel.canvas.width, (0.5 - pt.y / panel.metersH) * panel.canvas.height];
  }

  // How far outside the nearest window the ray passes, in room metres.
  outside() {
    let least = Infinity;
    for (const p of this.panels) {
      if (!p.mesh.visible) continue;
      const at = this.onPlane(p);
      if (!at) continue;
      const W = p.canvas.width, H = p.canvas.height;
      const dx = Math.max(0, -at[0], at[0] - W) * p.meters / W, dy = Math.max(0, -at[1], at[1] - H) * p.metersH / H;
      least = Math.min(least, Math.hypot(dx, dy));
    }
    return least;
  }

  dispatch(id, meshes, trigger, grip, dt) {
    // A drag in progress owns the pointer until its button is released.
    const drag = this.drag[id];
    if (drag) {
      const btn = drag.button === 'grip' ? grip : trigger;
      if (!btn || !btn.pressed) { this.drag[id] = null; if (this.onMoved) this.onMoved(drag.panel); }
      else { this.moveDragged(drag); return; }
    }

    this._hits.length = 0;
    const hits = this.raycaster.intersectObjects(meshes, false, this._hits);
    // Keep the captured panel while a slider drag is in progress.
    let captured = null;
    for (const p of this.panels) if (p.captures.has(id)) { captured = p; break; }
    let hit = hits[0] ?? null;
    if (captured && hit && hit.object !== captured.mesh) hit = null;
    this.hover[id] = hit;

    // The window the pointer is on: the one the ray meets, one whose slider it holds past the
    // edge, or one a pull began on though the ray has slipped off it since.
    const steady = this.steady[id];
    const kept = steady && steady.engaged && this.on[id] && this.on[id].mesh.visible ? this.on[id] : null;
    const panel = hit ? hit.object.userData.panel : captured ?? kept;
    let at = !panel ? null : hit ? panel.uvToPx(hit.uv) : this.onPlane(panel);
    const raw = at;
    if (steady) {
      if (this.on[id] !== panel) steady.reset();
      const far = hit ? hit.distance / this.rig.scale : 1;
      at = steady.update({ at, value: trigger.value, pressed: trigger.pressed, stray: panel ? STRAY * far / panel.meters * panel.canvas.width : 0, dt });
    }
    const prev = this.on[id];
    if (prev && prev !== panel) { prev.pointerLeave(id); prev.pointerUp(id); }
    this.on[id] = panel;
    const inside = !!at && at[0] >= 0 && at[0] <= panel.canvas.width && at[1] >= 0 && at[1] <= panel.canvas.height;
    this.aim[id] = inside ? { panel, x: at[0], y: at[1] } : null;
    if (!panel) return;
    if (inside) {
      const [x, y] = at;
      panel.showCursor(id, { x: x / panel.canvas.width, y: y / panel.canvas.height });
      panel.pointerMove(id, x, y);
      if (trigger.down) {
        const what = panel.pointerDown(id, x, y);
        if (this.onPress && panel.took) this.onPress(id);
        if (this.log) this.log('menu.press', { hand: id, window: panel.title, what: panel.lastPressed, at: [Math.round(x), Math.round(y)], slip: steady ? Math.round(steady.slip) : 0 });
        if (what === 'title') this.startDrag(id, panel, raw ?? at, 'trigger');
      }
      if (grip && grip.down && !this.heldElsewhere(panel)) this.startDrag(id, panel, raw ?? at, 'grip');
    } else {
      if (!captured) panel.pointerLeave(id);
      // Dragging past the edge: the point on the panel's plane.
      else if (trigger.pressed && at) panel.pointerMove(id, at[0], at[1]);
    }
    if (trigger.up) panel.pointerUp(id);
  }

  heldElsewhere(panel) {
    for (const d of Object.values(this.drag)) if (d && d.panel === panel) return true;
    return false;
  }

  // px: the point of the window taken hold of, in its canvas pixels.
  startDrag(id, panel, px, button) {
    panel.pointerUp(id);
    panel.pointerLeave(id);
    this.hover[id] = null;
    this.aim[id] = null;
    this.on[id] = null;
    const offset = new THREE.Vector3((px[0] / panel.canvas.width - 0.5) * panel.meters, (0.5 - px[1] / panel.canvas.height) * panel.metersH, 0);
    const far = panel.mesh.localToWorld(this._v.copy(offset)).distanceTo(this.raycaster.ray.origin);
    // Distance in room metres so zooming during the drag does not move the window.
    this.drag[id] = { panel, dist: far / this.rig.scale, offset, button };
  }

  // Put the grabbed point on the ray at the grab distance and turn the window toward the head.
  moveDragged(drag) {
    const mesh = drag.panel.mesh;
    const parent = mesh.parent;
    const target = this._v.copy(this.raycaster.ray.origin).addScaledVector(this.raycaster.ray.direction, drag.dist * this.rig.scale);
    parent.worldToLocal(target);
    const head = parent.worldToLocal(this.rig.headWorld().clone());
    head.y = target.y;
    // lookAt's z axis runs from target to eye, which is the plane normal we want.
    this._m.lookAt(head, target, UP);
    mesh.quaternion.setFromRotationMatrix(this._m);
    mesh.position.copy(target).sub(this._v2.copy(drag.offset).applyQuaternion(mesh.quaternion));
  }

  leave(id) {
    const prev = this.on[id];
    if (prev) { prev.pointerLeave(id); prev.pointerUp(id); }
    this.on[id] = null;
    this.hover[id] = null;
    this.aim[id] = null;
    if (this.steady[id]) this.steady[id].reset();
    for (const p of this.panels) if (p.captures.has(id)) { p.pointerUp(id); p.pointerLeave(id); }
    this.drag[id] = null;
  }
}
