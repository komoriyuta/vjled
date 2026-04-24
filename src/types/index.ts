export type SceneType = "glsl" | "p5" | "threejs" | "video";

export interface Scene {
  id: string;
  name: string;
  type: SceneType;
  code: string;
}

export type BusLabel = "A" | "B";

export interface VJState {
  scenes: Scene[];
  busA: string | null;
  busB: string | null;
  crossfade: number;
  isPlaying: boolean;
  selectedSceneId: string | null;
}
