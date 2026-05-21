import { useRef, useEffect, useCallback } from "react";
import type { Scene } from "../types";
import type { Renderer } from "../renderers/types";
import { createRenderer } from "../renderers/index";
import { Compositor } from "../renderers/compositor";
import { emitVideoCmd, listenVideoCmd, listenVJState, requestVJState, type VJStatePayload } from "../events/vjEvents";
import { sendLedFrameFromCanvas } from "../led/pixelExtractor";
import type { CalibrationPoint, LedConfig } from "../types";
import { emptyAudioAnalysis } from "../stores/vjStore";

interface UseEngineOptions {
  outputContainerRef: React.RefObject<HTMLDivElement | null>;
  preview: boolean;
  busAPreviewRef?: React.RefObject<HTMLCanvasElement | null>;
  busBPreviewRef?: React.RefObject<HTMLCanvasElement | null>;
  selectedPreviewRef?: React.RefObject<HTMLCanvasElement | null>;
  selectedPreviewRefs?: React.RefObject<HTMLCanvasElement | null>[];
  scenePreviewCanvasesRef?: React.RefObject<Map<string, HTMLCanvasElement | null>>;
  ledConfig?: LedConfig | null;
  ledPoints?: CalibrationPoint[];
}

interface RendererEntry {
  renderer: Renderer;
  canvas: HTMLCanvasElement;
}

function copyCanvas(src: HTMLCanvasElement | null, dst: HTMLCanvasElement | null) {
  if (!src || !dst) return;
  const ctx = dst.getContext("2d");
  if (!ctx) return;
  ctx.drawImage(src, 0, 0, dst.width, dst.height);
}

function clearCanvas(canvas: HTMLCanvasElement | null | undefined) {
  const ctx = canvas?.getContext("2d");
  if (!ctx || !canvas) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function compactControlCommands(commands: { action: string; value: unknown }[]) {
  const latest = new Map<string, { action: string; value: unknown }>();
  for (const cmd of commands) {
    const key = cmd.action === "play" || cmd.action === "pause" ? "transport" : cmd.action;
    latest.set(key, cmd);
  }
  return Array.from(latest.values());
}

export function useEngine(opts: UseEngineOptions) {
  const { outputContainerRef, preview, busAPreviewRef, busBPreviewRef, selectedPreviewRef, selectedPreviewRefs, scenePreviewCanvasesRef, ledConfig, ledPoints } = opts;

  const renderersRef = useRef<Map<string, RendererEntry>>(new Map());
  const loadingRenderersRef = useRef<Map<string, Promise<RendererEntry | null>>>(new Map());
  const compositorRef = useRef<Compositor | null>(null);
  const compositorCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const stateRef = useRef<VJStatePayload>({
    scenes: [],
    busA: null,
    busB: null,
    crossfade: 0,
    mix: { mode: "crossfade", intensity: 0.7, feather: 0.08 },
    isPlaying: true,
    selectedSceneId: null,
    audio: emptyAudioAnalysis,
  });
  const rafRef = useRef(0);
  const t0Ref = useRef(performance.now());
  const prevRef = useRef(0);
  const codeCacheRef = useRef<Map<string, string>>(new Map());
  const controlCacheRef = useRef<Map<string, { action: string; value: unknown }[]>>(new Map());
  const ledLastSendRef = useRef(0);
  const lastBpmRef = useRef(120);
  const syncVersionRef = useRef(0);
  const disposedRef = useRef(false);
  const ledConfigRef = useRef(ledConfig);
  const ledPointsRef = useRef(ledPoints);
  ledConfigRef.current = ledConfig;
  ledPointsRef.current = ledPoints;

  const scale = preview ? 0.25 : 1;
  const W = Math.round(1920 * scale);
  const H = Math.round(1080 * scale);

  const getOrCreate = useCallback(
    async (scene: Scene): Promise<RendererEntry | null> => {
      const existing = renderersRef.current.get(scene.id);
      if (existing) return existing;
      const loading = loadingRenderersRef.current.get(scene.id);
      if (loading) return loading;

      const load = (async () => {
        const r = await createRenderer(scene.type);
        if (!r) return null;

        const c = document.createElement("canvas");
        c.width = W;
        c.height = H;

        r.init(c);
        if (scene.code) {
          r.setCode(scene.code);
          codeCacheRef.current.set(scene.id, scene.code);
        }

        if (disposedRef.current) {
          r.destroy();
          c.remove();
          codeCacheRef.current.delete(scene.id);
          return null;
        }

        const entry = { renderer: r, canvas: c };
        renderersRef.current.set(scene.id, entry);
        for (const cmd of controlCacheRef.current.get(scene.id) ?? []) {
          r.control?.(cmd.action, cmd.value);
        }
        return entry;
      })();

      loadingRenderersRef.current.set(scene.id, load);
      try {
        return await load;
      } finally {
        loadingRenderersRef.current.delete(scene.id);
      }
    },
    [W, H],
  );

  const sendCommand = useCallback((sceneId: string, action: string, value: unknown) => {
    const commands = controlCacheRef.current.get(sceneId) ?? [];
    commands.push({ action, value });
    controlCacheRef.current.set(sceneId, compactControlCommands(commands));
    const entry = renderersRef.current.get(sceneId);
    entry?.renderer.control?.(action, value);
    emitVideoCmd({ sceneId, action, value });
  }, []);

  const getVideoInfo = useCallback((sceneId: string) => {
    const entry = renderersRef.current.get(sceneId);
    return entry?.renderer.getVideoInfo?.() ?? null;
  }, []);

  useEffect(() => {
    const container = outputContainerRef.current;
    if (!container) return;
    disposedRef.current = false;

    const compCanvas = document.createElement("canvas");
    compCanvas.width = W;
    compCanvas.height = H;
    compCanvas.style.cssText = "width:100%;height:100%;object-fit:contain;display:block;";
    container.appendChild(compCanvas);
    compositorCanvasRef.current = compCanvas;

    const comp = new Compositor();
    comp.init(compCanvas);
    compositorRef.current = comp;

    const unlistenState = listenVJState((state) => {
      stateRef.current = state;
      const syncVersion = ++syncVersionRef.current;

      const { scenes, busA, busB, selectedSceneId } = state;
      const activeScenes = scenes.filter((scene) => !scene.renderPaused);
      const activeIds = new Set<string>();
      if (busA && activeScenes.some((scene) => scene.id === busA)) activeIds.add(busA);
      if (busB && activeScenes.some((scene) => scene.id === busB)) activeIds.add(busB);
      const hasSelectedPreview = !!selectedPreviewRef || (selectedPreviewRefs?.length ?? 0) > 0;
      if (hasSelectedPreview && selectedSceneId && activeScenes.some((scene) => scene.id === selectedSceneId)) activeIds.add(selectedSceneId);
      for (const [id, canvas] of scenePreviewCanvasesRef?.current ?? []) {
        if (canvas && activeScenes.some((scene) => scene.id === id)) activeIds.add(id);
      }

      for (const [id, entry] of renderersRef.current) {
        if (!activeIds.has(id)) {
          entry.renderer.destroy();
          entry.canvas.remove();
          renderersRef.current.delete(id);
          codeCacheRef.current.delete(id);
        }
      }

      void (async () => {
        const lookup = new Map(activeScenes.map((s) => [s.id, s]));
        for (const id of activeIds) {
          const scene = lookup.get(id);
          if (!scene) continue;
          const entry = await getOrCreate(scene);
          if (syncVersion !== syncVersionRef.current) {
            if (entry && !activeIds.has(id)) {
              entry.renderer.destroy();
              entry.canvas.remove();
              renderersRef.current.delete(id);
              codeCacheRef.current.delete(id);
            }
            return;
          }
          if (!entry) continue;

          const prevCode = codeCacheRef.current.get(id);
          if (prevCode !== scene.code) {
            entry.renderer.setCode(scene.code);
            codeCacheRef.current.set(id, scene.code);
            for (const cmd of controlCacheRef.current.get(id) ?? []) {
              entry.renderer.control?.(cmd.action, cmd.value);
            }
          }

          if (scene.type === "video" && scene.videoSync) {
            entry.renderer.control?.("syncSettings", {
              enabled: scene.videoSync.enabled,
              measuresPerLoop: scene.videoSync.measuresPerLoop,
              bpm: stateRef.current.audio.bpm || 120,
            });
          }
        }
      })();
    });

    const unlistenVideoCmd = listenVideoCmd(({ sceneId, action, value }) => {
      const commands = controlCacheRef.current.get(sceneId) ?? [];
      commands.push({ action, value });
      controlCacheRef.current.set(sceneId, compactControlCommands(commands));
      const entry = renderersRef.current.get(sceneId);
      entry?.renderer.control?.(action, value);
    });

    requestVJState();

    let running = true;
    function loop() {
      if (!running) return;
      const { busA, busB, crossfade, mix, isPlaying, selectedSceneId, scenes, audio } = stateRef.current;
      const sceneById = new Map(scenes.map((scene) => [scene.id, scene]));
      const activeBusA = busA && !sceneById.get(busA)?.renderPaused ? busA : null;
      const activeBusB = busB && !sceneById.get(busB)?.renderPaused ? busB : null;
      const activeSelectedSceneId = selectedSceneId && !sceneById.get(selectedSceneId)?.renderPaused ? selectedSceneId : null;
      const now = performance.now();
      const time = (now - t0Ref.current) / 1000;
      const dt = time - prevRef.current;
      prevRef.current = time;

      const currentBpm = audio.bpm || 120;
      if (currentBpm !== lastBpmRef.current) {
        lastBpmRef.current = currentBpm;
        const lookup = new Map(scenes.map((s) => [s.id, s]));
        for (const [id, entry] of renderersRef.current) {
          const scene = lookup.get(id);
          if (scene?.type === "video" && scene.videoSync) {
            entry.renderer.control?.("syncSettings", {
              enabled: scene.videoSync.enabled,
              measuresPerLoop: scene.videoSync.measuresPerLoop,
              bpm: currentBpm,
            });
          }
        }
      }

      if (isPlaying) {
        const updatedIds = new Set<string>();

        if (activeBusA) {
          const entry = renderersRef.current.get(activeBusA);
          if (entry) {
            entry.renderer.update(time, dt, audio);
            updatedIds.add(activeBusA);
          }
        }
        if (activeBusB) {
          const entry = renderersRef.current.get(activeBusB);
          if (entry) {
            entry.renderer.update(time, dt, audio);
            updatedIds.add(activeBusB);
          }
        }
        if (activeSelectedSceneId && activeSelectedSceneId !== activeBusA && activeSelectedSceneId !== activeBusB) {
          const entry = renderersRef.current.get(activeSelectedSceneId);
          if (entry) {
            entry.renderer.update(time, dt, audio);
            updatedIds.add(activeSelectedSceneId);
          }
        }
        for (const [id, canvas] of scenePreviewCanvasesRef?.current ?? []) {
          if (sceneById.get(id)?.renderPaused) {
            clearCanvas(canvas);
            continue;
          }
          if (!canvas || updatedIds.has(id)) continue;
          const entry = renderersRef.current.get(id);
          if (entry) {
            entry.renderer.update(time, dt, audio);
            updatedIds.add(id);
          }
        }

        const lookup = new Map(scenes.map((s) => [s.id, s]));
        const cA = activeBusA ? renderersRef.current.get(activeBusA)?.canvas ?? null : null;
        const cB = activeBusB ? renderersRef.current.get(activeBusB)?.canvas ?? null : null;
        const sceneA = activeBusA ? lookup.get(activeBusA) : undefined;
        const sceneB = activeBusB ? lookup.get(activeBusB) : undefined;
        compositorRef.current?.render(cA, cB, {
          crossfade,
          mix,
          keyA: sceneA?.key,
          keyB: sceneB?.key,
        });

        copyCanvas(cA, busAPreviewRef?.current ?? null);
        if (!cA) clearCanvas(busAPreviewRef?.current);
        copyCanvas(cB, busBPreviewRef?.current ?? null);
        if (!cB) clearCanvas(busBPreviewRef?.current);
        const selEntry = activeSelectedSceneId ? renderersRef.current.get(activeSelectedSceneId) : null;
        copyCanvas(selEntry?.canvas ?? null, selectedPreviewRef?.current ?? null);
        if (!selEntry) clearCanvas(selectedPreviewRef?.current);
        for (const ref of selectedPreviewRefs ?? []) {
          copyCanvas(selEntry?.canvas ?? null, ref.current);
          if (!selEntry) clearCanvas(ref.current);
        }
        for (const [id, canvas] of scenePreviewCanvasesRef?.current ?? []) {
          if (sceneById.get(id)?.renderPaused) continue;
          copyCanvas(renderersRef.current.get(id)?.canvas ?? null, canvas);
        }

        if (!preview && compositorCanvasRef.current && ledConfigRef.current?.enabled && ledPointsRef.current && ledPointsRef.current.length > 0) {
          const now2 = performance.now();
          if (now2 - ledLastSendRef.current >= 33) {
            ledLastSendRef.current = now2;
            const compCanvas = compositorCanvasRef.current;
            sendLedFrameFromCanvas(compCanvas, ledPointsRef.current, ledConfigRef.current);
          }
        }
      }

      rafRef.current = requestAnimationFrame(loop);
    }
    rafRef.current = requestAnimationFrame(loop);

    return () => {
      running = false;
      disposedRef.current = true;
      syncVersionRef.current++;
      cancelAnimationFrame(rafRef.current);
      unlistenState.then((fn) => fn());
      unlistenVideoCmd.then((fn) => fn());
      for (const [, e] of renderersRef.current) {
        e.renderer.destroy();
        e.canvas.remove();
      }
      renderersRef.current.clear();
      loadingRenderersRef.current.clear();
      codeCacheRef.current.clear();
      controlCacheRef.current.clear();
      compositorRef.current?.destroy();
      compositorCanvasRef.current?.remove();
    };
  }, [outputContainerRef, W, H, getOrCreate, busAPreviewRef, busBPreviewRef, selectedPreviewRef, selectedPreviewRefs, scenePreviewCanvasesRef]);

  return { sendCommand, getVideoInfo };
}
