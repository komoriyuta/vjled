import { emptyAudioAnalysis } from "./stores/vjStore";
import type {
  AudioAnalysis,
  CalibrationPoint,
  LedConfig,
  LayoutInfo,
  Scene,
  SceneType,
  VJState,
  VideoSync,
} from "./types";

export interface ProjectAiSettings {
  baseUrl: string;
  model: string;
}

export interface ProjectAudioSettings {
  enabled: boolean;
  deviceId: string;
  deviceLabel: string;
}

export interface ProjectData {
  app: "vjled";
  version: 2;
  savedAt: string;
  vj: {
    scenes: Scene[];
    busA: string | null;
    busB: string | null;
    crossfade: number;
    isPlaying: boolean;
    selectedSceneId: string | null;
    audio: ProjectAudioSettings;
  };
  led: {
    config: LedConfig;
    calibrationPoints: CalibrationPoint[];
    layoutInfo: LayoutInfo | null;
  };
  ai: ProjectAiSettings;
}

export interface ParsedProject {
  vj: VJState;
  led: {
    config: LedConfig;
    calibrationPoints: CalibrationPoint[];
    layoutInfo: LayoutInfo | null;
  };
  ai: ProjectAiSettings | null;
}

const sceneTypes = new Set<SceneType>(["glsl", "p5", "threejs", "video"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  return Math.max(min, Math.min(max, finiteNumber(value, fallback)));
}

function parseVideoSync(value: unknown): VideoSync | undefined {
  if (!isRecord(value)) return undefined;
  return {
    enabled: Boolean(value.enabled),
    measuresPerLoop: Math.max(1, Math.round(finiteNumber(value.measuresPerLoop, 4))),
  };
}

function parseScenes(value: unknown): Scene[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index) => {
    if (!isRecord(item)) return [];
    const type = item.type;
    if (typeof type !== "string" || !sceneTypes.has(type as SceneType)) return [];

    const id = typeof item.id === "string" && item.id ? item.id : `scene-${index + 1}`;
    const scene: Scene = {
      id,
      name: typeof item.name === "string" && item.name ? item.name : `${type} #${index + 1}`,
      type: type as SceneType,
      code: typeof item.code === "string" ? item.code : "",
    };
    const videoSync = parseVideoSync(item.videoSync);
    if (videoSync) scene.videoSync = videoSync;
    return [scene];
  });
}

function existingSceneId(value: unknown, scenes: Scene[]): string | null {
  const id = stringOrNull(value);
  return id && scenes.some((scene) => scene.id === id) ? id : null;
}

function parseAudio(value: unknown): AudioAnalysis {
  const audio = isRecord(value) ? value : {};
  return {
    ...emptyAudioAnalysis,
    enabled: Boolean(audio.enabled),
    permission: Boolean(audio.enabled) ? "requesting" : "idle",
    deviceId: typeof audio.deviceId === "string" ? audio.deviceId : "",
    deviceLabel: typeof audio.deviceLabel === "string" ? audio.deviceLabel : "",
  };
}

function parseLedConfig(value: unknown, fallback: LedConfig): LedConfig {
  if (!isRecord(value)) return fallback;
  const gain = Array.isArray(value.colorGain) ? value.colorGain : fallback.colorGain;
  return {
    enabled: Boolean(value.enabled),
    brightness: clamp(value.brightness, 0, 1, fallback.brightness),
    colorGain: [
      clamp(gain[0], 0, 4, fallback.colorGain[0]),
      clamp(gain[1], 0, 4, fallback.colorGain[1]),
      clamp(gain[2], 0, 4, fallback.colorGain[2]),
    ],
    broadcastIp: typeof value.broadcastIp === "string" ? value.broadcastIp : fallback.broadcastIp,
    port: Math.max(1, Math.min(65535, Math.round(finiteNumber(value.port, fallback.port)))),
    deviceId: Math.max(0, Math.round(finiteNumber(value.deviceId, fallback.deviceId))),
    pixelCount: Math.max(1, Math.round(finiteNumber(value.pixelCount, fallback.pixelCount))),
    layoutPath: typeof value.layoutPath === "string" ? value.layoutPath : null,
    cameraDeviceId: typeof value.cameraDeviceId === "string" ? value.cameraDeviceId : null,
  };
}

function parseCalibrationPoints(value: unknown): CalibrationPoint[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const lanternId = finiteNumber(item.lanternId, NaN);
    const x = finiteNumber(item.x, NaN);
    const y = finiteNumber(item.y, NaN);
    if (!Number.isFinite(lanternId) || !Number.isFinite(x) || !Number.isFinite(y)) return [];
    return [{
      lanternId: Math.max(0, Math.round(lanternId)),
      x: Math.max(0, Math.min(1, x)),
      y: Math.max(0, Math.min(1, y)),
    }];
  });
}

function parseLayoutInfo(value: unknown): LayoutInfo | null {
  if (!isRecord(value) || !Array.isArray(value.devices)) return null;
  return {
    total_pixels: Math.max(0, Math.round(finiteNumber(value.total_pixels, 0))),
    device_count: Math.max(0, Math.round(finiteNumber(value.device_count, 0))),
    devices: value.devices.flatMap((device) => {
      if (!isRecord(device)) return [];
      return [{
        key: typeof device.key === "string" ? device.key : "",
        device_id: Math.max(0, Math.round(finiteNumber(device.device_id, 0))),
        total_pixels: Math.max(0, Math.round(finiteNumber(device.total_pixels, 0))),
        controller_ip: typeof device.controller_ip === "string" ? device.controller_ip : "",
      }];
    }),
  };
}

function parseAiSettings(value: unknown): ProjectAiSettings | null {
  if (!isRecord(value)) return null;
  return {
    baseUrl: typeof value.baseUrl === "string" && value.baseUrl ? value.baseUrl : "https://api.openai.com/v1",
    model: typeof value.model === "string" && value.model ? value.model : "gpt-4o",
  };
}

export function createProjectData(args: {
  vj: VJState;
  led: { config: LedConfig; calibrationPoints: CalibrationPoint[]; layoutInfo: LayoutInfo | null };
  ai: ProjectAiSettings;
}): ProjectData {
  return {
    app: "vjled",
    version: 2,
    savedAt: new Date().toISOString(),
    vj: {
      scenes: args.vj.scenes,
      busA: args.vj.busA,
      busB: args.vj.busB,
      crossfade: args.vj.crossfade,
      isPlaying: args.vj.isPlaying,
      selectedSceneId: args.vj.selectedSceneId,
      audio: {
        enabled: args.vj.audio.enabled,
        deviceId: args.vj.audio.deviceId,
        deviceLabel: args.vj.audio.deviceLabel,
      },
    },
    led: {
      config: args.led.config,
      calibrationPoints: args.led.calibrationPoints,
      layoutInfo: args.led.layoutInfo,
    },
    ai: args.ai,
  };
}

export function parseProjectData(raw: unknown, fallbackLedConfig: LedConfig): ParsedProject {
  if (!isRecord(raw)) {
    throw new Error("Project file is not a JSON object");
  }

  const root = raw.version === 1
    ? raw
    : raw.app === "vjled" && raw.version === 2
      ? raw
      : raw;

  const vjRaw = isRecord(root.vj) ? root.vj : {};
  const scenes = parseScenes(vjRaw.scenes);
  const audio = parseAudio(vjRaw.audio);
  const vj: VJState = {
    scenes,
    busA: existingSceneId(vjRaw.busA, scenes),
    busB: existingSceneId(vjRaw.busB, scenes),
    crossfade: clamp(vjRaw.crossfade, 0, 1, 0),
    isPlaying: Boolean(vjRaw.isPlaying ?? true),
    selectedSceneId: existingSceneId(vjRaw.selectedSceneId, scenes) ?? scenes[0]?.id ?? null,
    audio,
  };

  const ledRaw = isRecord(root.led) ? root.led : {};
  return {
    vj,
    led: {
      config: parseLedConfig(ledRaw.config, fallbackLedConfig),
      calibrationPoints: parseCalibrationPoints(ledRaw.calibrationPoints),
      layoutInfo: parseLayoutInfo(ledRaw.layoutInfo),
    },
    ai: parseAiSettings(root.ai),
  };
}
