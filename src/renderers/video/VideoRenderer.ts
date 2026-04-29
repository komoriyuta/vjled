import type { Renderer } from "../types";

export class VideoRenderer implements Renderer {
  private video: HTMLVideoElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private currentSrc = "";
  private loopEnabled = true;
  private loopStart = 0;
  private loopEnd = -1;
  private boundOnTimeUpdate: (() => void) | null = null;
  private boundOnEnded: (() => void) | null = null;
  private syncEnabled = false;
  private measuresPerLoop = 1;
  private bpm = 120;
  private loopPhaseStart = 0;

  init(canvas: HTMLCanvasElement): void {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.video = document.createElement("video");
    this.video.playsInline = true;
    this.video.muted = true;
    this.video.loop = false;
    this.video.crossOrigin = "anonymous";
    this.video.preload = "auto";

    this.boundOnTimeUpdate = () => this.onTimeUpdate();
    this.boundOnEnded = () => this.onEnded();
    this.video.addEventListener("timeupdate", this.boundOnTimeUpdate);
    this.video.addEventListener("ended", this.boundOnEnded);
    this.syncNativeLoop();
  }

  private syncNativeLoop(): void {
    if (!this.video) return;
    this.video.loop = this.loopEnabled && !this.syncEnabled && this.loopStart <= 0 && this.loopEnd < 0;
  }

  private getLoopEnd(): number {
    if (!this.video) return -1;
    if (this.syncEnabled && this.bpm > 0) {
      const loopDuration = this.measuresPerLoop * 240 / this.bpm;
      const end = this.loopStart + loopDuration;
      const maxEnd = this.video.duration || 0;
      return maxEnd > 0 ? Math.min(end, maxEnd) : end;
    }
    return this.loopEnd >= 0 ? this.loopEnd : this.video.duration;
  }

  private getLoopDuration(): number {
    if (this.syncEnabled && this.bpm > 0) {
      return this.measuresPerLoop * 240 / this.bpm;
    }
    if (!this.video) return 0;
    const end = this.loopEnd >= 0 ? this.loopEnd : this.video.duration;
    return end - this.loopStart;
  }

  private enforceLoop(): void {
    if (!this.video || !this.loopEnabled) return;
    const end = this.getLoopEnd();
    if (end > 0 && this.video.currentTime >= end) {
      this.video.currentTime = this.loopStart;
      this.loopPhaseStart = performance.now();
      if (this.video.paused) {
        this.video.play().catch(() => {});
      }
    }
  }

  private onTimeUpdate(): void {
    this.enforceLoop();
  }

  private onEnded(): void {
    this.enforceLoop();
  }

  setCode(code: string): void {
    const src = code.trim();
    if (!src || !this.video) return;
    if (src === this.currentSrc) return;
    this.currentSrc = src;
    this.loopStart = 0;
    this.loopEnd = -1;
    this.loopPhaseStart = performance.now();
    this.video.src = src;
    this.syncNativeLoop();
    this.video.load();
    this.video.play().catch(() => {});
  }

  update(_time: number, _dt: number): void {
    if (!this.video || !this.ctx || !this.canvas) return;

    if (this.syncEnabled && this.loopEnabled && this.bpm > 0 && this.video.readyState >= 2) {
      const elapsed = (performance.now() - this.loopPhaseStart) / 1000;
      const loopDuration = this.measuresPerLoop * 240 / this.bpm;
      if (loopDuration > 0 && elapsed >= loopDuration) {
        const loops = Math.floor(elapsed / loopDuration);
        this.loopPhaseStart += loops * loopDuration * 1000;
        this.video.currentTime = this.loopStart;
        if (this.video.paused) {
          this.video.play().catch(() => {});
        }
      }
    } else {
      this.enforceLoop();
    }

    if (this.video.readyState >= 2) {
      this.ctx.drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height);
    }
  }

  control(action: string, value: unknown): void {
    if (!this.video) return;
    switch (action) {
      case "play":
        this.video.play().catch(() => {});
        break;
      case "pause":
        this.video.pause();
        break;
      case "seek":
        if (typeof value === "number") {
          this.video.currentTime = value;
          this.loopPhaseStart = performance.now() - (value - this.loopStart) * 1000;
        }
        break;
      case "loop":
        this.loopEnabled = !!value;
        this.syncNativeLoop();
        break;
      case "loopStart":
        if (typeof value === "number") {
          this.loopStart = value;
          this.syncNativeLoop();
          this.loopPhaseStart = performance.now();
        }
        break;
      case "loopEnd":
        if (typeof value === "number") {
          this.loopEnd = value;
          this.syncNativeLoop();
        }
        break;
      case "syncSettings": {
        const v = value as { enabled?: boolean; measuresPerLoop?: number; bpm?: number };
        if (v.enabled !== undefined) this.syncEnabled = v.enabled;
        if (v.measuresPerLoop !== undefined) this.measuresPerLoop = v.measuresPerLoop;
        if (v.bpm !== undefined) this.bpm = v.bpm;
        this.syncNativeLoop();
        if (this.syncEnabled) {
          this.loopPhaseStart = performance.now();
        }
        break;
      }
      case "volume":
        if (typeof value === "number") this.video.volume = Math.max(0, Math.min(1, value));
        break;
      case "muted":
        this.video.muted = !!value;
        break;
    }
  }

  getVideoInfo(): { currentTime: number; duration: number; playing: boolean; loop: boolean; loopStart: number; loopEnd: number } | null {
    if (!this.video) return null;
    return {
      currentTime: this.video.currentTime,
      duration: this.video.duration || 0,
      playing: !this.video.paused && !this.video.ended,
      loop: this.loopEnabled,
      loopStart: this.loopStart,
      loopEnd: this.loopEnd >= 0 ? this.loopEnd : (this.video.duration || 0),
    };
  }

  getSyncInfo(): { enabled: boolean; measuresPerLoop: number; bpm: number; loopDuration: number } | null {
    return {
      enabled: this.syncEnabled,
      measuresPerLoop: this.measuresPerLoop,
      bpm: this.bpm,
      loopDuration: this.getLoopDuration(),
    };
  }

  resize(w: number, h: number): void {
    if (this.canvas) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  destroy(): void {
    if (this.video) {
      if (this.boundOnTimeUpdate) {
        this.video.removeEventListener("timeupdate", this.boundOnTimeUpdate);
        this.boundOnTimeUpdate = null;
      }
      if (this.boundOnEnded) {
        this.video.removeEventListener("ended", this.boundOnEnded);
        this.boundOnEnded = null;
      }
      this.video.pause();
      this.video.removeAttribute("src");
      this.video.load();
      this.video = null;
    }
    this.ctx = null;
    this.currentSrc = "";
  }
}
