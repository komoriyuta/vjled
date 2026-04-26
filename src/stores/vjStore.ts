import { create } from "zustand";
import type { Scene, SceneType, VJState } from "../types";
import { getDefaultCode } from "../defaults";

interface VJStore extends VJState {
  addScene: (type: SceneType) => void;
  removeScene: (id: string) => void;
  updateSceneCode: (id: string, code: string) => void;
  renameScene: (id: string, name: string) => void;
  setBusA: (id: string | null) => void;
  setBusB: (id: string | null) => void;
  setCrossfade: (v: number) => void;
  cutToA: () => void;
  cutToB: () => void;
  fadeToA: () => void;
  fadeToB: () => void;
  setPlaying: (p: boolean) => void;
  selectScene: (id: string | null) => void;
  loadProject: (data: VJState) => void;
}

let _nextId = 1;

export const useVJStore = create<VJStore>((set, get) => ({
  scenes: [],
  busA: null,
  busB: null,
  crossfade: 0,
  isPlaying: true,
  selectedSceneId: null,

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

  setBusA: (id) => set({ busA: id }),
  setBusB: (id) => set({ busB: id }),
  setCrossfade: (v) => set({ crossfade: Math.max(0, Math.min(1, v)) }),

  cutToA: () => set({ crossfade: 0 }),
  cutToB: () => set({ crossfade: 1 }),

  fadeToA: () => {
    const start = get().crossfade;
    const startT = performance.now();
    const dur = 1000;
    const step = () => {
      const t = Math.min(1, (performance.now() - startT) / dur);
      const ease = t * (2 - t);
      set({ crossfade: start * (1 - ease) });
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  },

  fadeToB: () => {
    const start = get().crossfade;
    const startT = performance.now();
    const dur = 1000;
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
      isPlaying: data.isPlaying,
      selectedSceneId: data.selectedSceneId,
    });
  },
}));
