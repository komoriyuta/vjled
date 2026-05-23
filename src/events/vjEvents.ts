import { emit, listen } from "@tauri-apps/api/event";
import type { AudioAnalysis, CalibrationPoint, LedConfig, LayoutInfo, MappingHandle, MixSettings, Scene } from "../types";

export interface VJStatePayload {
  scenes: Scene[];
  busA: string | null;
  busB: string | null;
  crossfade: number;
  mix: MixSettings;
  isPlaying: boolean;
  selectedSceneId: string | null;
  audio: AudioAnalysis;
  clockTimeSeconds?: number;
  clockSentAtMs?: number;
}

export interface VideoCmdPayload {
  sceneId: string;
  action: string;
  value: unknown;
}

export interface LedStatePayload {
  source?: string;
  config: LedConfig;
  calibrationPoints: CalibrationPoint[];
  layoutInfo: LayoutInfo | null;
  mappingHandles?: MappingHandle[];
  rawCameraPoints?: CalibrationPoint[];
  connected: boolean;
}

export interface VJRuntimePayload {
  crossfade: number;
  mix: MixSettings;
  isPlaying: boolean;
  clockTimeSeconds?: number;
  clockSentAtMs?: number;
}

type Handler<T> = (payload: T) => void;
type Unlisten = () => void;

const LOCAL_VJ_STATE = "vjled:vj-state";
const LOCAL_VJ_AUDIO = "vjled:vj-audio";
const LOCAL_VJ_RUNTIME = "vjled:vj-runtime";
const LOCAL_VIDEO_CMD = "vjled:video-cmd";
const LOCAL_STATE_REQUEST = "vjled:vj-state-request";
const LOCAL_LED_STATE = "vjled:led-state";
const LOCAL_LED_STATE_REQUEST = "vjled:led-state-request";

function emitLocal<T>(name: string, payload: T): void {
  window.dispatchEvent(new CustomEvent(name, { detail: payload }));
}

function listenLocal<T>(name: string, handler: Handler<T>): Unlisten {
  const listener = (ev: Event) => handler((ev as CustomEvent<T>).detail);
  window.addEventListener(name, listener);
  return () => window.removeEventListener(name, listener);
}

function emitTauri<T>(name: string, payload: T): void {
  emit(name, payload).catch(() => {
    // Browser-only development does not provide Tauri IPC.
  });
}

function listenTauri<T>(name: string, handler: Handler<T>): Promise<Unlisten | null> {
  return listen<T>(name, (ev) => handler(ev.payload)).catch(() => null);
}

export function emitVJState(payload: VJStatePayload): void {
  emitLocal(LOCAL_VJ_STATE, payload);
  emitTauri("vj-state", payload);
}

export async function listenVJState(handler: Handler<VJStatePayload>): Promise<Unlisten> {
  const localUnlisten = listenLocal<VJStatePayload>(LOCAL_VJ_STATE, handler);
  const tauriUnlisten = await listenTauri<VJStatePayload>("vj-state", handler);
  return () => {
    localUnlisten();
    tauriUnlisten?.();
  };
}

export function emitVJAudio(payload: AudioAnalysis): void {
  emitLocal(LOCAL_VJ_AUDIO, payload);
  emitTauri("vj-audio", payload);
}

export async function listenVJAudio(handler: Handler<AudioAnalysis>): Promise<Unlisten> {
  const localUnlisten = listenLocal<AudioAnalysis>(LOCAL_VJ_AUDIO, handler);
  const tauriUnlisten = await listenTauri<AudioAnalysis>("vj-audio", handler);
  return () => {
    localUnlisten();
    tauriUnlisten?.();
  };
}

export function emitVJRuntime(payload: VJRuntimePayload): void {
  emitLocal(LOCAL_VJ_RUNTIME, payload);
  emitTauri("vj-runtime", payload);
}

export async function listenVJRuntime(handler: Handler<VJRuntimePayload>): Promise<Unlisten> {
  const localUnlisten = listenLocal<VJRuntimePayload>(LOCAL_VJ_RUNTIME, handler);
  const tauriUnlisten = await listenTauri<VJRuntimePayload>("vj-runtime", handler);
  return () => {
    localUnlisten();
    tauriUnlisten?.();
  };
}

export function emitVideoCmd(payload: VideoCmdPayload): void {
  emitLocal(LOCAL_VIDEO_CMD, payload);
  emitTauri("video-cmd", payload);
}

export async function listenVideoCmd(handler: Handler<VideoCmdPayload>): Promise<Unlisten> {
  const localUnlisten = listenLocal<VideoCmdPayload>(LOCAL_VIDEO_CMD, handler);
  const tauriUnlisten = await listenTauri<VideoCmdPayload>("video-cmd", handler);
  return () => {
    localUnlisten();
    tauriUnlisten?.();
  };
}

export function requestVJState(): void {
  emitLocal(LOCAL_STATE_REQUEST, undefined);
  emitTauri("vj-state-request", undefined);
}

export async function listenVJStateRequest(handler: () => void): Promise<Unlisten> {
  const localUnlisten = listenLocal<void>(LOCAL_STATE_REQUEST, handler);
  const tauriUnlisten = await listenTauri<void>("vj-state-request", handler);
  return () => {
    localUnlisten();
    tauriUnlisten?.();
  };
}

export function emitLedState(payload: LedStatePayload): void {
  emitLocal(LOCAL_LED_STATE, payload);
  emitTauri("led-state", payload);
}

export async function listenLedState(handler: Handler<LedStatePayload>): Promise<Unlisten> {
  const localUnlisten = listenLocal<LedStatePayload>(LOCAL_LED_STATE, handler);
  const tauriUnlisten = await listenTauri<LedStatePayload>("led-state", handler);
  return () => {
    localUnlisten();
    tauriUnlisten?.();
  };
}

export function requestLedState(): void {
  emitLocal(LOCAL_LED_STATE_REQUEST, undefined);
  emitTauri("led-state-request", undefined);
}

export async function listenLedStateRequest(handler: () => void): Promise<Unlisten> {
  const localUnlisten = listenLocal<void>(LOCAL_LED_STATE_REQUEST, handler);
  const tauriUnlisten = await listenTauri<void>("led-state-request", handler);
  return () => {
    localUnlisten();
    tauriUnlisten?.();
  };
}
