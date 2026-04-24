import { useRef, useEffect, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import type { Scene } from "../types";
import type { Renderer } from "../renderers/types";
import { createRenderer } from "../renderers/index";
import { Compositor } from "../renderers/compositor";

interface VJStatePayload {
  scenes: Scene[];
  busA: string | null;
  busB: string | null;
  crossfade: number;
  isPlaying: boolean;
  selectedSceneId: string | null;
}

interface UseEngineOptions {
  outputContainerRef: React.RefObject<HTMLDivElement | null>;
  preview: boolean;
  busAPreviewRef?: React.RefObject<HTMLCanvasElement | null>;
  busBPreviewRef?: React.RefObject<HTMLCanvasElement | null>;
  selectedPreviewRef?: React.RefObject<HTMLCanvasElement | null>;
}

function copyCanvas(src: HTMLCanvasElement | null, dst: HTMLCanvasElement | null) {
  if (!src || !dst) return;
  const ctx = dst.getContext("2d");
  if (!ctx) return;
  ctx.drawImage(src, 0, 0, dst.width, dst.height);
}

export function useEngine(opts: UseEngineOptions) {
  const { outputContainerRef, preview, busAPreviewRef, busBPreviewRef, selectedPreviewRef } = opts;

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
      return entry;
    },
    [W, H],
  );

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

    const unlisten = listen<VJStatePayload>("vj-state", (ev) => {
      stateRef.current = ev.payload;

      const { scenes, busA, busB, selectedSceneId } = ev.payload;
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
        }
      }
    });

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
          if (entry) entry.renderer.update(time, dt);
        }
        if (busB) {
          const entry = renderersRef.current.get(busB);
          if (entry) entry.renderer.update(time, dt);
        }
        if (selectedSceneId && selectedSceneId !== busA && selectedSceneId !== busB) {
          const entry = renderersRef.current.get(selectedSceneId);
          if (entry) entry.renderer.update(time, dt);
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
      }

      rafRef.current = requestAnimationFrame(loop);
    }
    rafRef.current = requestAnimationFrame(loop);

    return () => {
      running = false;
      cancelAnimationFrame(rafRef.current);
      unlisten.then((fn) => fn());
      for (const [, e] of renderersRef.current) {
        e.renderer.destroy();
        e.canvas.remove();
      }
      renderersRef.current.clear();
      codeCacheRef.current.clear();
      compositorRef.current?.destroy();
      compositorCanvasRef.current?.remove();
    };
  }, [outputContainerRef, W, H, getOrCreate, busAPreviewRef, busBPreviewRef, selectedPreviewRef]);
}
