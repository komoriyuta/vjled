import * as THREE from "three";
import type { Renderer } from "../types";
import type { AudioAnalysis } from "../../types";

export class ThreeJSRenderer implements Renderer {
  private renderer: THREE.WebGLRenderer | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private state: Record<string, unknown> = {};
  private _setup: ((s: THREE.Scene, c: THREE.PerspectiveCamera, r: THREE.WebGLRenderer) => Record<string, unknown>) | null = null;
  private _update: ((st: Record<string, unknown>, t: number, dt: number, audio: AudioAnalysis) => void) | null = null;
  private code = "";
  private initialized = false;

  init(canvas: HTMLCanvasElement): void {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      preserveDrawingBuffer: true,
    });
    this.renderer.setClearColor(0x000000, 1);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(75, canvas.width / canvas.height, 0.1, 1000);
    this.camera.position.z = 5;
  }

  setCode(code: string): void {
    if (code === this.code && this.initialized) return;
    this.code = code;
    this.initialized = true;
    this.evalCode();
  }

  private evalCode(): void {
    this._setup = null;
    this._update = null;
    this.state = {};

    if (this.scene) {
      while (this.scene.children.length > 0) {
        const obj = this.scene.children[0];
        this.scene.remove(obj);
        if (obj instanceof THREE.Mesh) {
          obj.geometry.dispose();
          if (Array.isArray(obj.material)) {
            obj.material.forEach((m) => m.dispose());
          } else {
            obj.material.dispose();
          }
        }
      }
    }

    try {
      const fn = new Function(
        "THREE",
        `"use strict";
        ${this.code}
        return {
          setup: typeof setup === 'function' ? setup : null,
          update: typeof update === 'function' ? update : null,
        };`
      );
      const result = fn(THREE) as {
        setup: ((s: THREE.Scene, c: THREE.PerspectiveCamera, r: THREE.WebGLRenderer) => Record<string, unknown>) | null;
        update: ((st: Record<string, unknown>, t: number, dt: number, audio: AudioAnalysis) => void) | null;
      };
      this._setup = result.setup;
      this._update = result.update;

      if (this._setup && this.scene && this.camera && this.renderer) {
        const userState = this._setup(this.scene, this.camera, this.renderer);
        this.state = userState ?? {};
      }
    } catch (e) {
      console.error("Three.js eval error:", e);
    }
  }

  update(time: number, dt: number, audio: AudioAnalysis): void {
    if (!this.renderer || !this.scene || !this.camera) return;

    if (this._update) {
      try {
        this.state.audio = audio;
        this._update(this.state, time, dt, audio);
      } catch (e) {
        console.error("Three.js update error:", e);
      }
    }

    this.renderer.render(this.scene, this.camera);
  }

  resize(w: number, h: number): void {
    if (this.renderer) this.renderer.setSize(w, h);
    if (this.camera) {
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
  }

  destroy(): void {
    if (this.scene) {
      this.scene.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry.dispose();
          if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
          else obj.material.dispose();
        }
      });
    }
    this.renderer?.dispose();
    this.renderer?.forceContextLoss();
    this.renderer = null;
    this.scene = null;
    this.camera = null;
  }
}
