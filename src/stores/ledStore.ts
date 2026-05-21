import { create } from "zustand";
import type { LedConfig, CalibrationPoint, LayoutInfo, MappingHandle } from "../types";

const LED_STATE_STORAGE_KEY = "vjled:led-state:v1";
const LEGACY_MAPPING_VIEW_STORAGE_KEY = "vjled:led-mapping-view:v1";

const defaultLedConfig: LedConfig = {
  enabled: false,
  brightness: 0.65,
  colorGain: [1.0, 1.0, 1.0],
  broadcastIp: "255.255.255.255",
  port: 7777,
  deviceId: 1,
  pixelCount: 25,
  layoutPath: null,
  cameraDeviceId: null,
};

interface PersistedLedState {
  config: LedConfig;
  layoutInfo: LayoutInfo | null;
  calibrationPoints: CalibrationPoint[];
  mappingHandles: MappingHandle[];
  rawCameraPoints: CalibrationPoint[];
}

interface LedStore {
  config: LedConfig;
  layoutInfo: LayoutInfo | null;
  calibrationPoints: CalibrationPoint[];
  mappingHandles: MappingHandle[];
  rawCameraPoints: CalibrationPoint[];
  calibrating: boolean;
  calibrationProgress: number;
  connected: boolean;
  cameraStream: MediaStream | null;

  setConfig: (config: Partial<LedConfig>) => void;
  setLayoutInfo: (info: LayoutInfo | null) => void;
  setCalibrationPoints: (points: CalibrationPoint[]) => void;
  setMappingHandles: (handles: MappingHandle[]) => void;
  setRawCameraPoints: (points: CalibrationPoint[]) => void;
  addCalibrationPoint: (point: CalibrationPoint) => void;
  setCalibrating: (v: boolean) => void;
  setCalibrationProgress: (v: number) => void;
  setConnected: (v: boolean) => void;
  setCameraStream: (stream: MediaStream | null) => void;
  resetCalibration: () => void;
  loadProject: (
    config: LedConfig,
    points: CalibrationPoint[],
    layoutInfo?: LayoutInfo | null,
    mappingHandles?: MappingHandle[],
    rawCameraPoints?: CalibrationPoint[],
  ) => void;
  loadSyncedState: (
    config: LedConfig,
    points: CalibrationPoint[],
    layoutInfo: LayoutInfo | null,
    connected: boolean,
    mappingHandles?: MappingHandle[],
    rawCameraPoints?: CalibrationPoint[],
  ) => void;
}

const defaultMappingHandles: MappingHandle[] = [
  [0.15, 0.15], [0.85, 0.15], [0.85, 0.85], [0.15, 0.85],
];

function parseMappingHandles(value: unknown): MappingHandle[] {
  if (!Array.isArray(value) || value.length !== 4) return defaultMappingHandles;
  const parsed = value.map((item) => {
    if (!Array.isArray(item) || item.length !== 2) return null;
    const x = typeof item[0] === "number" && Number.isFinite(item[0]) ? item[0] : NaN;
    const y = typeof item[1] === "number" && Number.isFinite(item[1]) ? item[1] : NaN;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return [Math.max(0, Math.min(1, x)), Math.max(0, Math.min(1, y))] as MappingHandle;
  });
  return parsed.every(Boolean) ? parsed as MappingHandle[] : defaultMappingHandles;
}

function parseCalibrationPoints(value: unknown): CalibrationPoint[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const lanternId = typeof record.lanternId === "number" && Number.isFinite(record.lanternId) ? record.lanternId : NaN;
    const x = typeof record.x === "number" && Number.isFinite(record.x) ? record.x : NaN;
    const y = typeof record.y === "number" && Number.isFinite(record.y) ? record.y : NaN;
    if (!Number.isFinite(lanternId) || !Number.isFinite(x) || !Number.isFinite(y)) return [];
    return [{ lanternId: Math.max(0, Math.round(lanternId)), x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) }];
  });
}

function readPersistedLedState(): PersistedLedState {
  if (typeof window === "undefined") {
    return { config: defaultLedConfig, layoutInfo: null, calibrationPoints: [], mappingHandles: defaultMappingHandles, rawCameraPoints: [] };
  }
  try {
    const raw = window.localStorage.getItem(LED_STATE_STORAGE_KEY);
    if (!raw) {
      try {
        const legacy = JSON.parse(window.localStorage.getItem(LEGACY_MAPPING_VIEW_STORAGE_KEY) ?? "{}") as {
          handles?: unknown;
          rawCamPoints?: unknown;
        };
        return {
          config: defaultLedConfig,
          layoutInfo: null,
          calibrationPoints: [],
          mappingHandles: parseMappingHandles(legacy.handles),
          rawCameraPoints: parseCalibrationPoints(legacy.rawCamPoints),
        };
      } catch {
        return { config: defaultLedConfig, layoutInfo: null, calibrationPoints: [], mappingHandles: defaultMappingHandles, rawCameraPoints: [] };
      }
    }
    const parsed = JSON.parse(raw) as Partial<PersistedLedState>;
    let legacyMapping: Partial<Pick<PersistedLedState, "mappingHandles" | "rawCameraPoints">> = {};
    if (!parsed.mappingHandles || !parsed.rawCameraPoints) {
      try {
        const legacy = JSON.parse(window.localStorage.getItem(LEGACY_MAPPING_VIEW_STORAGE_KEY) ?? "{}") as {
          handles?: unknown;
          rawCamPoints?: unknown;
        };
        legacyMapping = {
          mappingHandles: parseMappingHandles(legacy.handles),
          rawCameraPoints: parseCalibrationPoints(legacy.rawCamPoints),
        };
      } catch {}
    }
    return {
      config: { ...defaultLedConfig, ...parsed.config },
      layoutInfo: parsed.layoutInfo ?? null,
      calibrationPoints: parseCalibrationPoints(parsed.calibrationPoints),
      mappingHandles: parseMappingHandles(parsed.mappingHandles ?? legacyMapping.mappingHandles),
      rawCameraPoints: parseCalibrationPoints(parsed.rawCameraPoints ?? legacyMapping.rawCameraPoints),
    };
  } catch {
    return { config: defaultLedConfig, layoutInfo: null, calibrationPoints: [], mappingHandles: defaultMappingHandles, rawCameraPoints: [] };
  }
}

function persistLedState(state: Pick<LedStore, "config" | "layoutInfo" | "calibrationPoints" | "mappingHandles" | "rawCameraPoints">): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(LED_STATE_STORAGE_KEY, JSON.stringify({
    config: state.config,
    layoutInfo: state.layoutInfo,
    calibrationPoints: state.calibrationPoints,
    mappingHandles: state.mappingHandles,
    rawCameraPoints: state.rawCameraPoints,
  }));
}

const persisted = readPersistedLedState();

export const useLedStore = create<LedStore>((set) => ({
  config: persisted.config,
  layoutInfo: persisted.layoutInfo,
  calibrationPoints: persisted.calibrationPoints,
  mappingHandles: persisted.mappingHandles,
  rawCameraPoints: persisted.rawCameraPoints,
  calibrating: false,
  calibrationProgress: 0,
  connected: false,
  cameraStream: null,

  setConfig: (partial) =>
    set((s) => {
      const next = { ...s, config: { ...s.config, ...partial } };
      persistLedState(next);
      return { config: next.config };
    }),
  setLayoutInfo: (info) =>
    set((s) => {
      const next = { ...s, layoutInfo: info };
      persistLedState(next);
      return { layoutInfo: info };
    }),
  setCalibrationPoints: (points) =>
    set((s) => {
      const next = { ...s, calibrationPoints: points };
      persistLedState(next);
      return { calibrationPoints: points };
    }),
  setMappingHandles: (handles) =>
    set((s) => {
      const next = { ...s, mappingHandles: handles };
      persistLedState(next);
      return { mappingHandles: handles };
    }),
  setRawCameraPoints: (points) =>
    set((s) => {
      const next = { ...s, rawCameraPoints: points };
      persistLedState(next);
      return { rawCameraPoints: points };
    }),
  addCalibrationPoint: (point) =>
    set((s) => {
      const calibrationPoints = [...s.calibrationPoints, point];
      const next = { ...s, calibrationPoints };
      persistLedState(next);
      return { calibrationPoints };
    }),
  setCalibrating: (v) => set({ calibrating: v }),
  setCalibrationProgress: (v) => set({ calibrationProgress: v }),
  setConnected: (v) => set({ connected: v }),
  setCameraStream: (stream) => set({ cameraStream: stream }),
  resetCalibration: () =>
    set((s) => {
      const next = { ...s, calibrationPoints: [], rawCameraPoints: [] };
      persistLedState(next);
      return { calibrationPoints: [], rawCameraPoints: [], calibrationProgress: 0 };
    }),
  loadProject: (config, points, layoutInfo = null, mappingHandles = defaultMappingHandles, rawCameraPoints = []) =>
    set((s) => {
      const next = { ...s, config, calibrationPoints: points, layoutInfo, mappingHandles, rawCameraPoints };
      persistLedState(next);
      return { config, calibrationPoints: points, layoutInfo, mappingHandles, rawCameraPoints, connected: false };
    }),
  loadSyncedState: (config, points, layoutInfo, connected, mappingHandles = defaultMappingHandles, rawCameraPoints = []) =>
    set((s) => {
      const next = { ...s, config, calibrationPoints: points, layoutInfo, mappingHandles, rawCameraPoints };
      persistLedState(next);
      return { config, calibrationPoints: points, layoutInfo, mappingHandles, rawCameraPoints, connected };
    }),
}));
