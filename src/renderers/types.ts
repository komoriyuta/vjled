import type { AudioAnalysis } from "../types";

export interface Renderer {
  init(canvas: HTMLCanvasElement): void;
  setCode(code: string): void;
  update(time: number, dt: number, audio: AudioAnalysis): void;
  resize(w: number, h: number): void;
  destroy(): void;
  control?(action: string, value: unknown): void;
  getVideoInfo?(): { currentTime: number; duration: number; playing: boolean; loop: boolean; loopStart: number; loopEnd: number; bpmLoop: boolean; beatsPerLoop: number } | null;
}
