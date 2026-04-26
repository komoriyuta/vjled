import { useRef, useEffect, useCallback } from "react";
import type { Scene } from "../types";
import type { Renderer } from "../renderers/types";
import { createRenderer } from "../renderers/index";
import { Compositor } from "../renderers/compositor";
import { emitVideoCmd, listenLinkState, listenVideoCmd, listenVJState, requestVJState, type VJStatePayload } from "../events/vjEvents";
import { sendLedFrame } from "../led/pixelExtractor";
import type { CalibrationPoint, LedConfig, LinkState } from "../types";

interface UseEngineOptions {
  outputContainerRef: React.RefObject<HTMLDivElement | null>;
  preview: boolean;
  busAPreviewRef?: React.RefObject<HTMLCanvasElement | null>;
  busBPreviewRef?: React.RefObject<HTMLCanvasElement | null>;
  selectedPreviewRef?: React.RefObject<HTMLCanvasElement | null>;
  ledConfig?: LedConfig | null;
  ledPoints?: CalibrationPoint[];
}

function copyCanvas(src: HTMLCanvasElement | null, dst: HTMLCanvasElement | null) {
  if (!src || !dst) return;
  const ctx = dst.getContext("2d");
  if (!ctx) return;
  ctx.drawImage(src, 0, 0, dst.width, dst.height);
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
  const { outputContainerRef, preview, busAPreviewRef, busBPreviewRef, selectedPreviewRef, ledConfig, ledPoints } = opts;

  const renderersRef = useRef<Map<string, { renderer: Renderer; canvas: HTMLCanvasElement }>>(new Map());
  const compositorRef = useRef<Compositor | null>(null);
  const compositorCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const stateRef = useRef<VJStatePayload>({
    scenes: [],
    busA: null,
    busB: null,
    crossfade: 0,
    isPlaying: true,
    selectedSceneId: null,
  });
  const rafRef = useRef(0);
  const t0Ref = useRef(performance.now());
  const prevRef = useRef(0);
  const codeCacheRef = useRef<Map<string, string>>(new Map());
  const controlCacheRef = useRef<Map<string, { action: string; value: unknown }[]>>(new Map());
  const ledLastSendRef = useRef(0);
  const linkStateRef = useRef<LinkState | null>(null);
  const ledConfigRef = useRef(ledConfig);
  const ledPointsRef = useRef(ledPoints);
  ledConfigRef.current = ledConfig;
  ledPointsRef.current = ledPoints;

  const scale = preview ? 0.25 : 1;
  const W = Math.round(1920 * scale);
  const H = Math.round(1080 * scale);

  const getOrCreate = useCallback(
    (scene: Scene) => {
      const existing = renderersRef.current.get(scene.id);
      if (existing) return existing;

      const r = createRenderer(scene.type);
      if (!r) return null;

      const c = document.createElement("canvas");
      c.width = W;
      c.height = H;

      r.init(c);
      if (scene.code) {
        r.setCode(scene.code);
        codeCacheRef.current.set(scene.id, scene.code);
      }

      const entry = { renderer: r, canvas: c };
      renderersRef.current.set(scene.id, entry);
      for (const cmd of controlCacheRef.current.get(scene.id) ?? []) {
        r.control?.(cmd.action, cmd.value);
      }
      r.setLinkState?.(linkStateRef.current);
      return entry;
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

      const { scenes, busA, busB, selectedSceneId } = state;
      const activeIds = new Set<string>();
      if (busA) activeIds.add(busA);
      if (busB) activeIds.add(busB);
      if (selectedPreviewRef && selectedSceneId) activeIds.add(selectedSceneId);

      for (const [id, entry] of renderersRef.current) {
        if (!activeIds.has(id)) {
          entry.renderer.destroy();
          entry.canvas.remove();
          renderersRef.current.delete(id);
          codeCacheRef.current.delete(id);
        }
      }

      const lookup = new Map(scenes.map((s) => [s.id, s]));
      for (const id of activeIds) {
        const scene = lookup.get(id);
        if (!scene) continue;
        const entry = getOrCreate(scene);
        if (!entry) continue;

        const prevCode = codeCacheRef.current.get(id);
        if (prevCode !== scene.code) {
          entry.renderer.setCode(scene.code);
          codeCacheRef.current.set(id, scene.code);
          for (const cmd of controlCacheRef.current.get(id) ?? []) {
            entry.renderer.control?.(cmd.action, cmd.value);
          }
        }
      }
    });

    const unlistenVideoCmd = listenVideoCmd(({ sceneId, action, value }) => {
      const commands = controlCacheRef.current.get(sceneId) ?? [];
      commands.push({ action, value });
      controlCacheRef.current.set(sceneId, compactControlCommands(commands));
      const entry = renderersRef.current.get(sceneId);
      entry?.renderer.control?.(action, value);
    });

    const unlistenLinkState = listenLinkState((state) => {
      linkStateRef.current = state;
      for (const [, entry] of renderersRef.current) {
        entry.renderer.setLinkState?.(state);
      }
    });

    requestVJState();

    let running = true;
    function loop() {
      if (!running) return;
      const { busA, busB, crossfade, isPlaying, selectedSceneId } = stateRef.current;
      const now = performance.now();
      const time = (now - t0Ref.current) / 1000;
      const dt = time - prevRef.current;
      prevRef.current = time;

      if (isPlaying) {
        if (busA) {
          const entry = renderersRef.current.get(busA);
          if (entry) {
            entry.renderer.setLinkState?.(linkStateRef.current);
            entry.renderer.update(time, dt);
          }
        }
        if (busB) {
          const entry = renderersRef.current.get(busB);
          if (entry) {
            entry.renderer.setLinkState?.(linkStateRef.current);
            entry.renderer.update(time, dt);
          }
        }
        if (selectedSceneId && selectedSceneId !== busA && selectedSceneId !== busB) {
          const entry = renderersRef.current.get(selectedSceneId);
          if (entry) {
            entry.renderer.setLinkState?.(linkStateRef.current);
            entry.renderer.update(time, dt);
          }
        }

        const cA = busA ? renderersRef.current.get(busA)?.canvas ?? null : null;
        const cB = busB ? renderersRef.current.get(busB)?.canvas ?? null : null;
        compositorRef.current?.render(cA, cB, crossfade);

        copyCanvas(cA, busAPreviewRef?.current ?? null);
        copyCanvas(cB, busBPreviewRef?.current ?? null);
        if (selectedSceneId) {
          const selEntry = renderersRef.current.get(selectedSceneId);
          copyCanvas(selEntry?.canvas ?? null, selectedPreviewRef?.current ?? null);
        }

        if (!preview && compositorCanvasRef.current && ledConfigRef.current?.enabled && ledPointsRef.current && ledPointsRef.current.length > 0) {
          const now2 = performance.now();
          if (now2 - ledLastSendRef.current >= 33) {
            ledLastSendRef.current = now2;
            const compCanvas = compositorCanvasRef.current;
            const compCtx = compCanvas.getContext("2d");
            if (compCtx) {
              sendLedFrame(compCtx, compCanvas.width, compCanvas.height, ledPointsRef.current, ledConfigRef.current);
            }
          }
        }
      }

      rafRef.current = requestAnimationFrame(loop);
    }
    rafRef.current = requestAnimationFrame(loop);

    return () => {
      running = false;
      cancelAnimationFrame(rafRef.current);
      unlistenState.then((fn) => fn());
      unlistenVideoCmd.then((fn) => fn());
      unlistenLinkState.then((fn) => fn());
      for (const [, e] of renderersRef.current) {
        e.renderer.destroy();
        e.canvas.remove();
      }
      renderersRef.current.clear();
      codeCacheRef.current.clear();
      controlCacheRef.current.clear();
      compositorRef.current?.destroy();
      compositorCanvasRef.current?.remove();
    };
  }, [outputContainerRef, W, H, getOrCreate, busAPreviewRef, busBPreviewRef, selectedPreviewRef]);

  return { sendCommand, getVideoInfo };
}
