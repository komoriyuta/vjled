import { create } from "zustand";
import type { AudioAnalysis, AudioInputDevice, MixMode, MixSettings, Scene, SceneKeySettings, SceneType, VJState } from "../types";
import { getDefaultCode } from "../defaults";

interface VJStore extends VJState {
  audioDevices: AudioInputDevice[];
  addScene: (type: SceneType) => void;
  removeScene: (id: string) => void;
  updateSceneCode: (id: string, code: string) => void;
  renameScene: (id: string, name: string) => void;
  setSceneRenderPaused: (id: string, paused: boolean) => void;
  setBusA: (id: string | null) => void;
  setBusB: (id: string | null) => void;
  setCrossfade: (v: number) => void;
  setMixMode: (mode: MixMode) => void;
  setMixSettings: (mix: Partial<MixSettings>) => void;
  setSceneKey: (sceneId: string, key: SceneKeySettings) => void;
  cutToA: () => void;
  cutToB: () => void;
  fadeToA: (durationMs?: number) => void;
  fadeToB: (durationMs?: number) => void;
  setPlaying: (p: boolean) => void;
  selectScene: (id: string | null) => void;
  setAudioDevices: (devices: AudioInputDevice[]) => void;
  setAudioDevice: (deviceId: string, label?: string) => void;
  setAudioEnabled: (enabled: boolean) => void;
  setAudioAnalysis: (audio: Partial<AudioAnalysis>) => void;
  loadProject: (data: VJState) => void;
  setVideoSync: (sceneId: string, sync: import("../types").VideoSync) => void;
}

const VJ_STATE_STORAGE_KEY = "vjled:vj-state:v1";

let _nextId = 1;

export const emptyAudioAnalysis: AudioAnalysis = {
  enabled: false,
  permission: "idle",
  deviceId: "",
  deviceLabel: "",
  fft: Array.from({ length: 32 }, () => 0),
  bpm: 0,
  beat: false,
  beatPhase: 0,
  beatCount: 0,
  genre: null,
  genreConfidence: 0,
  musicTags: [],
  moodPredictions: [],
};

export const defaultMixSettings: MixSettings = {
  mode: "crossfade",
  intensity: 0.7,
  feather: 0.08,
};

function defaultVJState(): VJState {
  return {
    scenes: [],
    busA: null,
    busB: null,
    crossfade: 0,
    mix: defaultMixSettings,
    isPlaying: true,
    selectedSceneId: null,
    audio: emptyAudioAnalysis,
  };
}

function readPersistedVJState(): VJState {
  if (typeof window === "undefined") return defaultVJState();
  try {
    const raw = window.localStorage.getItem(VJ_STATE_STORAGE_KEY);
    if (!raw) return defaultVJState();
    const parsed = JSON.parse(raw) as Partial<VJState>;
    const scenes = Array.isArray(parsed.scenes)
      ? parsed.scenes.flatMap((scene) => {
          if (typeof scene !== "object" || scene === null || Array.isArray(scene)) return [];
          const item = scene as Partial<Scene>;
          if (typeof item.id !== "string" || typeof item.name !== "string" || typeof item.type !== "string" || typeof item.code !== "string") return [];
          if (!["glsl", "p5", "threejs", "video"].includes(item.type)) return [];
          return [{
            id: item.id,
            name: item.name,
            type: item.type as SceneType,
            code: item.code,
            renderPaused: !!item.renderPaused,
            videoSync: item.videoSync,
            key: item.key,
          }];
        })
      : [];
    const ids = new Set(scenes.map((scene) => scene.id));
    const maxNum = scenes.reduce((max, scene) => {
      const m = scene.id.match(/scene-(\d+)/);
      return m ? Math.max(max, parseInt(m[1], 10)) : max;
    }, 0);
    _nextId = Math.max(_nextId, maxNum + 1);
    const mix = parsed.mix ?? defaultMixSettings;
    return {
      scenes,
      busA: typeof parsed.busA === "string" && ids.has(parsed.busA) ? parsed.busA : null,
      busB: typeof parsed.busB === "string" && ids.has(parsed.busB) ? parsed.busB : null,
      crossfade: typeof parsed.crossfade === "number" && Number.isFinite(parsed.crossfade) ? Math.max(0, Math.min(1, parsed.crossfade)) : 0,
      mix: {
        ...defaultMixSettings,
        ...mix,
        intensity: Math.max(0, Math.min(1, mix.intensity ?? defaultMixSettings.intensity)),
        feather: Math.max(0.001, Math.min(0.5, mix.feather ?? defaultMixSettings.feather)),
      },
      isPlaying: typeof parsed.isPlaying === "boolean" ? parsed.isPlaying : true,
      selectedSceneId: typeof parsed.selectedSceneId === "string" && ids.has(parsed.selectedSceneId) ? parsed.selectedSceneId : null,
      audio: emptyAudioAnalysis,
    };
  } catch {
    return defaultVJState();
  }
}

function persistVJState(state: VJState): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(VJ_STATE_STORAGE_KEY, JSON.stringify({
    scenes: state.scenes,
    busA: state.busA,
    busB: state.busB,
    crossfade: state.crossfade,
    mix: state.mix,
    isPlaying: state.isPlaying,
    selectedSceneId: state.selectedSceneId,
  }));
}

const persistedVJState = readPersistedVJState();

export const useVJStore = create<VJStore>((set, get) => ({
  scenes: persistedVJState.scenes,
  busA: persistedVJState.busA,
  busB: persistedVJState.busB,
  crossfade: persistedVJState.crossfade,
  mix: persistedVJState.mix,
  isPlaying: persistedVJState.isPlaying,
  selectedSceneId: persistedVJState.selectedSceneId,
  audio: persistedVJState.audio,
  audioDevices: [],

  addScene: (type) => {
    const id = `scene-${_nextId++}`;
    const scene: Scene = {
      id,
      name: `${type} ${id.replace("scene-", "#")}`,
      type,
      code: getDefaultCode(type),
    };
    set((s) => {
      const scenes = [...s.scenes, scene];
      return {
        scenes,
        selectedSceneId: s.selectedSceneId ?? id,
        busA: s.busA ?? id,
      };
    });
  },

  removeScene: (id) =>
    set((s) => {
      const scenes = s.scenes.filter((sc) => sc.id !== id);
      return {
        scenes,
        busA: s.busA === id ? (scenes[0]?.id ?? null) : s.busA,
        busB: s.busB === id ? (scenes.length > 1 ? scenes[1]?.id ?? null : null) : s.busB,
        selectedSceneId: s.selectedSceneId === id ? (scenes[0]?.id ?? null) : s.selectedSceneId,
      };
    }),

  updateSceneCode: (id, code) =>
    set((s) => ({
      scenes: s.scenes.map((sc) => (sc.id === id ? { ...sc, code } : sc)),
    })),

  renameScene: (id, name) =>
    set((s) => ({
      scenes: s.scenes.map((sc) => (sc.id === id ? { ...sc, name } : sc)),
    })),

  setSceneRenderPaused: (id, paused) =>
    set((s) => ({
      scenes: s.scenes.map((sc) => (sc.id === id ? { ...sc, renderPaused: paused } : sc)),
      busA: paused && s.busA === id ? null : s.busA,
      busB: paused && s.busB === id ? null : s.busB,
    })),

  setBusA: (id) => set({ busA: id }),
  setBusB: (id) => set({ busB: id }),
  setCrossfade: (v) => set({ crossfade: Math.max(0, Math.min(1, v)) }),
  setMixMode: (mode) =>
    set((s) => ({
      mix: { ...s.mix, mode },
    })),
  setMixSettings: (mix) =>
    set((s) => ({
      mix: {
        ...s.mix,
        ...mix,
        intensity: Math.max(0, Math.min(1, mix.intensity ?? s.mix.intensity)),
        feather: Math.max(0.001, Math.min(0.5, mix.feather ?? s.mix.feather)),
      },
    })),
  setSceneKey: (sceneId, key) =>
    set((s) => ({
      scenes: s.scenes.map((sc) => (sc.id === sceneId ? { ...sc, key } : sc)),
    })),

  cutToA: () => set({ crossfade: 0 }),
  cutToB: () => set({ crossfade: 1 }),

  fadeToA: (durationMs = 1000) => {
    const start = get().crossfade;
    const startT = performance.now();
    const dur = Number.isFinite(durationMs) ? Math.max(50, durationMs) : 1000;
    const step = () => {
      const t = Math.min(1, (performance.now() - startT) / dur);
      const ease = t * (2 - t);
      set({ crossfade: start * (1 - ease) });
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  },

  fadeToB: (durationMs = 1000) => {
    const start = get().crossfade;
    const startT = performance.now();
    const dur = Number.isFinite(durationMs) ? Math.max(50, durationMs) : 1000;
    const step = () => {
      const t = Math.min(1, (performance.now() - startT) / dur);
      const ease = t * (2 - t);
      set({ crossfade: start + (1 - start) * ease });
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  },

  setPlaying: (p) => set({ isPlaying: p }),
  selectScene: (id) => set({ selectedSceneId: id }),
  setVideoSync: (sceneId, sync) =>
    set((s) => ({
      scenes: s.scenes.map((sc) => (sc.id === sceneId ? { ...sc, videoSync: sync } : sc)),
    })),
  setAudioDevices: (devices) => set({ audioDevices: devices }),
  setAudioDevice: (deviceId, label = "") =>
    set((s) => ({
      audio: {
        ...s.audio,
        deviceId,
        deviceLabel: label,
      },
    })),
  setAudioEnabled: (enabled) =>
    set((s) => ({
      audio: {
        ...s.audio,
        enabled,
        permission: enabled ? s.audio.permission : "idle",
        beat: false,
      },
    })),
  setAudioAnalysis: (audio) =>
    set((s) => ({
      audio: {
        ...s.audio,
        ...audio,
        fft: audio.fft ?? s.audio.fft,
      },
    })),
  loadProject: (data) => {
    const maxNum = data.scenes.reduce((max, s) => {
      const m = s.id.match(/scene-(\d+)/);
      return m ? Math.max(max, parseInt(m[1])) : max;
    }, 0);
    _nextId = maxNum + 1;
    set({
      scenes: data.scenes,
      busA: data.busA,
      busB: data.busB,
      crossfade: data.crossfade,
      mix: data.mix ?? defaultMixSettings,
      isPlaying: data.isPlaying,
      selectedSceneId: data.selectedSceneId,
      audio: {
        ...emptyAudioAnalysis,
        ...(data.audio ?? {}),
        beat: false,
      },
    });
  },
}));

useVJStore.subscribe((state, previous) => {
  if (
    state.scenes === previous.scenes &&
    state.busA === previous.busA &&
    state.busB === previous.busB &&
    state.mix === previous.mix &&
    state.isPlaying === previous.isPlaying &&
    state.selectedSceneId === previous.selectedSceneId
  ) {
    return;
  }
  persistVJState(state);
});
