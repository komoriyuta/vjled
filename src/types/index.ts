export type SceneType = "glsl" | "p5" | "threejs" | "video";

export interface VideoSync {
  enabled: boolean;
  measuresPerLoop: number;
}

export type MixMode =
  | "crossfade"
  | "additive"
  | "screen"
  | "multiply"
  | "overlay"
  | "softLight"
  | "difference"
  | "lighten"
  | "darken"
  | "wipeLeft"
  | "wipeRight"
  | "wipeUp"
  | "wipeDown"
  | "circle"
  | "diamond"
  | "dissolve"
  | "luma"
  | "ripple"
  | "glitch"
  | "rgbSplit";

export interface MixSettings {
  mode: MixMode;
  intensity: number;
  feather: number;
}

export interface SceneKeySettings {
  enabled: boolean;
  threshold: number;
  softness: number;
  spill: number;
}

export interface Scene {
  id: string;
  name: string;
  type: SceneType;
  code: string;
  renderPaused?: boolean;
  videoSync?: VideoSync;
  key?: SceneKeySettings;
}

export type BusLabel = "A" | "B";

export interface VJState {
  scenes: Scene[];
  busA: string | null;
  busB: string | null;
  crossfade: number;
  mix: MixSettings;
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
  fft: number[];
  bpm: number;
  beat: boolean;
  beatPhase: number;
  beatCount: number;
  genre: string | null;
  genreConfidence: number;
  musicTags: MusicTag[];
  moodPredictions: MoodPrediction[];
}

export interface MusicTag {
  label: string;
  confidence: number;
}

export interface MoodPrediction {
  label: string;
  confidence: number;
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
  sourceSceneId: string | null;
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

export type MappingHandle = [number, number];
