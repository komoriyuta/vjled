export interface Renderer {
  init(canvas: HTMLCanvasElement): void;
  setCode(code: string): void;
  update(time: number, dt: number): void;
  resize(w: number, h: number): void;
  destroy(): void;
}
