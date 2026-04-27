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

export interface LinkState {
  enabled: boolean;
  startStopSync: boolean;
  bpm: number;
  beat: number;
  phase: number;
  quantum: number;
  peers: number;
  playing: boolean;
  micros: number;
}

export interface DeviceInfo {
  key: string;
  device_id: number;
  total_pixels: number;
  controller_ip: string;
}

export interface LayoutInfo {
  total_pixels: number;
  device_count: number;
  devices: DeviceInfo[];
}

export interface LedConfig {
  enabled: boolean;
  brightness: number;
  colorGain: [number, number, number];
  broadcastIp: string;
  port: number;
  deviceId: number;
  pixelCount: number;
  layoutPath: string | null;
  cameraDeviceId: string | null;
}

export interface CalibrationPoint {
  lanternId: number;
  x: number;
  y: number;
}
