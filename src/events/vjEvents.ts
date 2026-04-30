import { emit, listen } from "@tauri-apps/api/event";
import type { AudioAnalysis, LinkState, Scene } from "../types";

export interface VJStatePayload {
  scenes: Scene[];
  busA: string | null;
  busB: string | null;
  crossfade: number;
  isPlaying: boolean;
  selectedSceneId: string | null;
  bpm: number;
  audio: AudioAnalysis;
}

export interface VideoCmdPayload {
  sceneId: string;
  action: string;
  value: unknown;
}

type Handler<T> = (payload: T) => void;
type Unlisten = () => void;

const LOCAL_VJ_STATE = "vjled:vj-state";
const LOCAL_VIDEO_CMD = "vjled:video-cmd";
const LOCAL_STATE_REQUEST = "vjled:vj-state-request";

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

export async function listenLinkState(handler: Handler<LinkState>): Promise<Unlisten> {
  const tauriUnlisten = await listenTauri<LinkState>("link-state", handler);
  return () => {
    tauriUnlisten?.();
  };
}
