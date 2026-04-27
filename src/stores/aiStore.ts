import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

interface AiConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

interface AiStore {
  config: AiConfig;
  generating: boolean;
  error: string | null;

  setConfig: (config: Partial<AiConfig>) => void;
  setGenerating: (v: boolean) => void;
  setError: (e: string | null) => void;
  generate: (
    sceneType: string,
    prompt: string,
    existingCode?: string,
  ) => Promise<string>;
}

const STORAGE_KEY = "vjled-ai-config";

function loadConfig(): AiConfig {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) return JSON.parse(saved);
  } catch {}
  return { baseUrl: "https://api.openai.com/v1", apiKey: "", model: "gpt-4o" };
}

function saveConfig(config: AiConfig) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {}
}

export const useAiStore = create<AiStore>((set, get) => ({
  config: loadConfig(),
  generating: false,
  error: null,

  setConfig: (partial) =>
    set((s) => {
      const config = { ...s.config, ...partial };
      saveConfig(config);
      return { config };
    }),
  setGenerating: (v) => set({ generating: v }),
  setError: (e) => set({ error: e }),

  generate: async (sceneType, prompt, existingCode) => {
    const { config } = get();
    set({ generating: true, error: null });
    try {
      const code = await invoke<string>("ai_generate", {
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        model: config.model,
        sceneType,
        prompt,
        existingCode: existingCode ?? null,
      });
      set({ generating: false });
      return code;
    } catch (e) {
      const errMsg = String(e);
      set({ generating: false, error: errMsg });
      throw new Error(errMsg);
    }
  },
}));
