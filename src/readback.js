import * as THREE from 'three';

// A few bytes back from the GPU without waiting on it: a scene rendered into a small target,
// its pixels copied to a buffer on the GPU's side, taken up in a later frame once a fence
// says they are there.
export class Readback {
  constructor(renderer, w, h) {
    this.renderer = renderer;
    this.w = w;
    this.h = h;
    this.rt = new THREE.WebGLRenderTarget(w, h, {
      format: THREE.RGBAFormat, type: THREE.UnsignedByteType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      generateMipmaps: false, depthBuffer: false, stencilBuffer: false,
    });
    this.bytes = new Uint8Array(w * h * 4);
    this.pbo = null;
    this.pending = null;
  }

  get busy() { return this.pending !== null; }

  // Render the scene and ask for its pixels. `tag` comes back with them.
  request(scene, camera, tag) {
    if (this.pending) throw new Error('readback: asked again before the last was taken up');
    const renderer = this.renderer, gl = renderer.getContext();
    const target = renderer.getRenderTarget(), xr = renderer.xr.enabled;
    renderer.xr.enabled = false;
    renderer.setRenderTarget(this.rt);
    renderer.render(scene, camera);
    if (!this.pbo) this.pbo = gl.createBuffer();
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
    // New storage each time: Chrome warns of a second write into storage it has a copy of.
    gl.bufferData(gl.PIXEL_PACK_BUFFER, this.bytes.byteLength, gl.STREAM_READ);
    gl.readPixels(0, 0, this.w, this.h, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    renderer.setRenderTarget(target);
    renderer.xr.enabled = xr;
    this.pending = { sync: gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0), tag };
  }

  // The tag of the last request once its pixels are in `bytes`, else null.
  poll() {
    const p = this.pending;
    if (!p) return null;
    const gl = this.renderer.getContext();
    const s = gl.clientWaitSync(p.sync, 0, 0);
    if (s === gl.TIMEOUT_EXPIRED) return null;
    gl.deleteSync(p.sync);
    this.pending = null;
    if (s === gl.WAIT_FAILED) throw new Error('readback: the wait on the GPU failed');
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this.bytes);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    return p.tag;
  }
}
