import type { Renderer } from "../types";

export class VideoRenderer implements Renderer {
  private video: HTMLVideoElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;

  init(canvas: HTMLCanvasElement): void {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.video = document.createElement("video");
    this.video.playsInline = true;
    this.video.muted = true;
    this.video.loop = true;
    this.video.crossOrigin = "anonymous";
  }

  setCode(code: string): void {
    const src = code.trim().split("\n").find((l) => !l.startsWith("#"))?.trim();
    if (!src || !this.video) return;
    if (this.video.src !== src) {
      this.video.src = src;
      this.video.load();
      this.video.play().catch(() => {});
    }
  }

  update(_time: number, _dt: number): void {
    if (!this.video || !this.ctx || !this.canvas) return;
    if (this.video.readyState >= 2) {
      this.ctx.drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height);
    }
  }

  resize(w: number, h: number): void {
    if (this.canvas) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  destroy(): void {
    if (this.video) {
      this.video.pause();
      this.video.removeAttribute("src");
      this.video.load();
      this.video = null;
    }
    this.ctx = null;
  }
}
