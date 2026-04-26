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
    this.video.loop = this.loopEnabled && this.loopStart <= 0 && this.loopEnd < 0;
  }

  private getLoopEnd(): number {
    if (!this.video) return -1;
    return this.loopEnd >= 0 ? this.loopEnd : this.video.duration;
  }

  private enforceLoop(): void {
    if (!this.video || !this.loopEnabled) return;
    const end = this.getLoopEnd();
    if (end > 0 && this.video.currentTime >= end) {
      this.video.currentTime = this.loopStart;
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
    this.video.src = src;
    this.syncNativeLoop();
    this.video.load();
    this.video.play().catch(() => {});
  }

  update(_time: number, _dt: number): void {
    if (!this.video || !this.ctx || !this.canvas) return;
    this.enforceLoop();
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
        if (typeof value === "number") this.video.currentTime = value;
        break;
      case "loop":
        this.loopEnabled = !!value;
        this.syncNativeLoop();
        break;
      case "loopStart":
        if (typeof value === "number") {
          this.loopStart = value;
          this.syncNativeLoop();
        }
        break;
      case "loopEnd":
        if (typeof value === "number") {
          this.loopEnd = value;
          this.syncNativeLoop();
        }
        break;
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
