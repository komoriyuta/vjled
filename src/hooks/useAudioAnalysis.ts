import { useEffect, useRef } from "react";
import { emptyAudioAnalysis, useVJStore } from "../stores/vjStore";

const FFT_BANDS = 32;
const MIN_BEAT_INTERVAL = 0.28;
const MAX_INTERVALS = 12;

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function normalizeBpm(bpm: number): number {
  let v = bpm;
  while (v < 70) v *= 2;
  while (v > 180) v /= 2;
  return v >= 70 && v <= 180 ? v : 0;
}

function bandAverage(data: Uint8Array, start: number, end: number): number {
  const from = Math.max(0, Math.min(data.length - 1, start));
  const to = Math.max(from + 1, Math.min(data.length, end));
  let sum = 0;
  for (let i = from; i < to; i++) sum += data[i];
  return sum / (to - from) / 255;
}

export function useAudioAnalysis(): void {
  const enabled = useVJStore((s) => s.audio.enabled);
  const source = useVJStore((s) => s.audio.source);
  const deviceId = useVJStore((s) => s.audio.deviceId);

  const rafRef = useRef(0);
  const streamRef = useRef<MediaStream | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const bassAvgRef = useRef(0);
  const lastBeatRef = useRef(0);
  const intervalsRef = useRef<number[]>([]);
  const beatCountRef = useRef(0);
  const bpmRef = useRef(0);
  const confidenceRef = useRef(0);

  useEffect(() => {
    let active = true;

    async function refreshDevices() {
      if (!navigator.mediaDevices?.enumerateDevices) return;
      const devices = await navigator.mediaDevices.enumerateDevices();
      if (!active) return;
      useVJStore.getState().setAudioDevices(
        devices
          .filter((d) => d.kind === "audioinput")
          .map((d, i) => ({
            deviceId: d.deviceId,
            label: d.label || `Microphone ${i + 1}`,
          })),
      );
    }

    refreshDevices().catch(() => {});
    navigator.mediaDevices?.addEventListener?.("devicechange", refreshDevices);

    return () => {
      active = false;
      navigator.mediaDevices?.removeEventListener?.("devicechange", refreshDevices);
    };
  }, []);

  useEffect(() => {
    let stopped = false;

    function stopAudio() {
      cancelAnimationFrame(rafRef.current);
      sourceRef.current?.disconnect();
      analyserRef.current?.disconnect();
      streamRef.current?.getTracks().forEach((track) => track.stop());
      contextRef.current?.close().catch(() => {});
      sourceRef.current = null;
      analyserRef.current = null;
      streamRef.current = null;
      contextRef.current = null;
      bassAvgRef.current = 0;
      lastBeatRef.current = 0;
      intervalsRef.current = [];
      beatCountRef.current = 0;
      bpmRef.current = 0;
      confidenceRef.current = 0;
    }

    async function startMic() {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      return stream;
    }

    async function startSystem() {
      const displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });
      const audioTracks = displayStream.getAudioTracks();
      if (audioTracks.length === 0) {
        displayStream.getVideoTracks().forEach((t) => t.stop());
        throw new Error("No system audio available. Share a tab/screen with audio.");
      }
      displayStream.getVideoTracks().forEach((t) => t.stop());
      const audioStream = new MediaStream(audioTracks);
      return audioStream;
    }

    async function startAudio() {
      if (!enabled) {
        stopAudio();
        useVJStore.getState().setAudioAnalysis({ ...emptyAudioAnalysis, source, deviceId, enabled: false });
        return;
      }

      if (!navigator.mediaDevices) {
        useVJStore.getState().setAudioAnalysis({ permission: "error", enabled: false });
        return;
      }

      useVJStore.getState().setAudioAnalysis({ permission: "requesting", enabled: true });

      try {
        const stream = source === "system" ? await startSystem() : await startMic();
        if (stopped) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }

        stopAudio();
        streamRef.current = stream;
        const context = new AudioContext();
        const src = context.createMediaStreamSource(stream);
        const analyser = context.createAnalyser();
        analyser.fftSize = 2048;
        analyser.smoothingTimeConstant = 0.72;
        src.connect(analyser);

        contextRef.current = context;
        sourceRef.current = src;
        analyserRef.current = analyser;

        const track = stream.getAudioTracks()[0];
        const label = track?.label ?? "";
        useVJStore.getState().setAudioAnalysis({ permission: "ready", deviceLabel: label, enabled: true });

        const freq = new Uint8Array(analyser.frequencyBinCount);
        const time = new Uint8Array(analyser.fftSize);

        const tick = () => {
          if (stopped || !analyserRef.current) return;
          const now = performance.now() / 1000;
          analyserRef.current.getByteFrequencyData(freq);
          analyserRef.current.getByteTimeDomainData(time);

          let rms = 0;
          for (const v of time) {
            const centered = (v - 128) / 128;
            rms += centered * centered;
          }
          const volume = clamp01(Math.sqrt(rms / time.length) * 2.2);
          const bass = bandAverage(freq, 1, 18);
          const mid = bandAverage(freq, 18, 120);
          const treble = bandAverage(freq, 120, 420);

          bassAvgRef.current = bassAvgRef.current === 0 ? bass : bassAvgRef.current * 0.96 + bass * 0.04;
          const threshold = Math.max(0.12, bassAvgRef.current * 1.45);
          const canBeat = now - lastBeatRef.current > MIN_BEAT_INTERVAL;
          const beat = canBeat && bass > threshold && volume > 0.04;

          if (beat) {
            if (lastBeatRef.current > 0) {
              const interval = now - lastBeatRef.current;
              if (interval >= 0.28 && interval <= 1.6) {
                intervalsRef.current = [...intervalsRef.current.slice(-(MAX_INTERVALS - 1)), interval];
                const bpm = normalizeBpm(60 / median(intervalsRef.current));
                if (bpm > 0) bpmRef.current = bpmRef.current ? bpmRef.current * 0.82 + bpm * 0.18 : bpm;
                confidenceRef.current = clamp01(intervalsRef.current.length / 8);
              }
            }
            lastBeatRef.current = now;
            beatCountRef.current += 1;
          }

          const bpm = bpmRef.current;
          const beatLen = bpm > 0 ? 60 / bpm : 0;
          const beatPhase = beatLen > 0 && lastBeatRef.current > 0 ? clamp01(((now - lastBeatRef.current) % beatLen) / beatLen) : 0;
          const bands = Array.from({ length: FFT_BANDS }, (_, i) => {
            const start = Math.floor((i / FFT_BANDS) * freq.length);
            const end = Math.floor(((i + 1) / FFT_BANDS) * freq.length);
            return Number(bandAverage(freq, start, end).toFixed(4));
          });

          useVJStore.getState().setAudioAnalysis({
            enabled: true,
            permission: "ready",
            volume: Number(volume.toFixed(4)),
            bass: Number(bass.toFixed(4)),
            mid: Number(mid.toFixed(4)),
            treble: Number(treble.toFixed(4)),
            fft: bands,
            bpm: Number(bpm.toFixed(1)),
            beat,
            beatPhase: Number(beatPhase.toFixed(4)),
            beatConfidence: Number(confidenceRef.current.toFixed(4)),
            beatCount: beatCountRef.current,
            lastBeatAt: lastBeatRef.current,
          });

          rafRef.current = requestAnimationFrame(tick);
        };

        rafRef.current = requestAnimationFrame(tick);
      } catch (error) {
        console.error("Audio input failed:", error);
        stopAudio();
        useVJStore.getState().setAudioAnalysis({ permission: "denied", enabled: false });
      }
    }

    startAudio();

    return () => {
      stopped = true;
      stopAudio();
    };
  }, [enabled, source, deviceId]);
}
