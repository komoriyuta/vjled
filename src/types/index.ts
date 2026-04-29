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
  audio: AudioAnalysis;
}

export interface AudioInputDevice {
  deviceId: string;
  label: string;
}

export type AudioPermissionState = "idle" | "requesting" | "ready" | "denied" | "error";

export interface AudioAnalysis {
  enabled: boolean;
  permission: AudioPermissionState;
  deviceId: string;
  deviceLabel: string;
  volume: number;
  bass: number;
  mid: number;
  treble: number;
  fft: number[];
  bpm: number;
  beat: boolean;
  beatPhase: number;
  beatConfidence: number;
  beatCount: number;
  lastBeatAt: number;
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
}

export interface CalibrationPoint {
  lanternId: number;
  x: number;
  y: number;
}
