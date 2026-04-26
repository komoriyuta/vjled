import { create } from "zustand";
import type { LedConfig, CalibrationPoint, LayoutInfo } from "../types";

interface LedStore {
  config: LedConfig;
  layoutInfo: LayoutInfo | null;
  calibrationPoints: CalibrationPoint[];
  calibrating: boolean;
  calibrationProgress: number;
  connected: boolean;
  cameraStream: MediaStream | null;

  setConfig: (config: Partial<LedConfig>) => void;
  setLayoutInfo: (info: LayoutInfo | null) => void;
  setCalibrationPoints: (points: CalibrationPoint[]) => void;
  addCalibrationPoint: (point: CalibrationPoint) => void;
  setCalibrating: (v: boolean) => void;
  setCalibrationProgress: (v: number) => void;
  setConnected: (v: boolean) => void;
  setCameraStream: (stream: MediaStream | null) => void;
  resetCalibration: () => void;
  loadProject: (config: LedConfig, points: CalibrationPoint[]) => void;
}

export const useLedStore = create<LedStore>((set) => ({
  config: {
    enabled: false,
    brightness: 0.65,
    colorGain: [1.0, 1.0, 1.0],
    broadcastIp: "192.168.11.255",
    port: 7777,
    deviceId: 1,
    pixelCount: 25,
    layoutPath: null,
  },
  layoutInfo: null,
  calibrationPoints: [],
  calibrating: false,
  calibrationProgress: 0,
  connected: false,
  cameraStream: null,

  setConfig: (partial) =>
    set((s) => ({ config: { ...s.config, ...partial } })),
  setLayoutInfo: (info) => set({ layoutInfo: info }),
  setCalibrationPoints: (points) => set({ calibrationPoints: points }),
  addCalibrationPoint: (point) =>
    set((s) => ({ calibrationPoints: [...s.calibrationPoints, point] })),
  setCalibrating: (v) => set({ calibrating: v }),
  setCalibrationProgress: (v) => set({ calibrationProgress: v }),
  setConnected: (v) => set({ connected: v }),
  setCameraStream: (stream) => set({ cameraStream: stream }),
  resetCalibration: () =>
    set({ calibrationPoints: [], calibrationProgress: 0 }),
  loadProject: (config, points) =>
    set({ config, calibrationPoints: points, connected: false }),
}));
