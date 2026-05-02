import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { emptyAudioAnalysis, useVJStore } from "../stores/vjStore";

interface RustAudioAnalysis {
  fft: number[];
  bpm: number;
  beat: boolean;
  beat_phase: number;
  beat_count: number;
}

export interface RustAudioDevice {
  id: string;
  name: string;
  is_input: boolean;
  is_output: boolean;
  is_default: boolean;
  is_loopback: boolean;
}

export function useAudioAnalysis(): void {
  const enabled = useVJStore((s) => s.audio.enabled);
  const deviceName = useVJStore((s) => s.audio.deviceId);

  const unlistenRef = useRef<(() => void)[]>([]);

  useEffect(() => {
    let mounted = true;

    async function setup() {
      unlistenRef.current.forEach((unlisten) => unlisten());
      unlistenRef.current = [];

      const unlistenAnalysis = await listen<RustAudioAnalysis>("audio-analysis", (ev) => {
        const d = ev.payload;
        useVJStore.getState().setAudioAnalysis({
          enabled: true,
          permission: "ready",
          fft: d.fft,
          bpm: d.bpm,
          beat: d.beat,
          beatPhase: d.beat_phase,
          beatCount: d.beat_count,
        });
      });
      const unlistenError = await listen<string>("audio-error", (ev) => {
        console.error("Audio capture error:", ev.payload);
        useVJStore.getState().setAudioAnalysis({
          enabled: false,
          permission: "error",
          beat: false,
        });
      });

      if (!mounted) {
        unlistenAnalysis();
        unlistenError();
        return;
      }

      unlistenRef.current = [unlistenAnalysis, unlistenError];
    }

    setup();

    return () => {
      mounted = false;
      unlistenRef.current.forEach((unlisten) => unlisten());
      unlistenRef.current = [];
    };
  }, []);

  useEffect(() => {
    if (enabled) {
      const device = deviceName || undefined;
      useVJStore.getState().setAudioAnalysis({ permission: "requesting" });
      invoke("audio_start", { device }).catch((e) => {
        console.error("Failed to start audio:", e);
        useVJStore.getState().setAudioAnalysis({ permission: "error", enabled: false });
      });
    } else {
      invoke("audio_stop").catch(() => {});
      useVJStore.getState().setAudioAnalysis({ ...emptyAudioAnalysis });
    }

    return () => {
      invoke("audio_stop").catch(() => {});
    };
  }, [enabled, deviceName]);
}

export async function listAudioDevices(): Promise<RustAudioDevice[]> {
  return invoke("audio_list_devices");
}
