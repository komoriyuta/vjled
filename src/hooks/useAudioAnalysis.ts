import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { emptyAudioAnalysis, useVJStore } from "../stores/vjStore";

interface RustAudioAnalysis {
  volume: number;
  bass: number;
  mid: number;
  treble: number;
  fft: number[];
  bpm: number;
  beat: boolean;
  beat_phase: number;
  beat_confidence: number;
  beat_count: number;
}

export interface RustAudioDevice {
  name: string;
  is_input: boolean;
  is_output: boolean;
}

export function useAudioAnalysis(): void {
  const enabled = useVJStore((s) => s.audio.enabled);
  const deviceName = useVJStore((s) => s.audio.deviceId);

  const unlistenRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let mounted = true;

    async function setup() {
      if (unlistenRef.current) {
        unlistenRef.current();
        unlistenRef.current = null;
      }

      const unlisten = await listen<RustAudioAnalysis>("audio-analysis", (ev) => {
        const d = ev.payload;
        useVJStore.getState().setAudioAnalysis({
          enabled: true,
          permission: "ready",
          volume: d.volume,
          bass: d.bass,
          mid: d.mid,
          treble: d.treble,
          fft: d.fft,
          bpm: d.bpm,
          beat: d.beat,
          beatPhase: d.beat_phase,
          beatConfidence: d.beat_confidence,
          beatCount: d.beat_count,
        });
      });

      if (!mounted) {
        unlisten();
        return;
      }

      unlistenRef.current = unlisten;
    }

    setup();

    return () => {
      mounted = false;
      if (unlistenRef.current) {
        unlistenRef.current();
        unlistenRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (enabled) {
      const device = deviceName || undefined;
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
