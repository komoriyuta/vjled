import type { AudioAnalysis, SceneType } from "../types";
import { createRenderer } from "./index";

export interface VisualValidationResult {
  ok: boolean;
  reason: string;
  activePixels: number;
  averageLuma: number;
  maxLuma: number;
}

const VALIDATION_W = 320;
const VALIDATION_H = 180;
const FRAMES_TO_TEST = 6;

function waitFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function analyzeCanvas(canvas: HTMLCanvasElement): VisualValidationResult {
  const probe = document.createElement("canvas");
  probe.width = VALIDATION_W;
  probe.height = VALIDATION_H;
  const ctx = probe.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    return { ok: false, reason: "2D canvas context unavailable", activePixels: 0, averageLuma: 0, maxLuma: 0 };
  }

  try {
    ctx.clearRect(0, 0, probe.width, probe.height);
    ctx.drawImage(canvas, 0, 0, probe.width, probe.height);
    const data = ctx.getImageData(0, 0, probe.width, probe.height).data;
    let activePixels = 0;
    let lumaSum = 0;
    let maxLuma = 0;

    for (let i = 0; i < data.length; i += 4) {
      const alpha = data[i + 3] / 255;
      const luma = (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) * alpha;
      lumaSum += luma;
      if (luma > maxLuma) maxLuma = luma;
      if (luma > 8) activePixels++;
    }

    const pixelCount = probe.width * probe.height;
    const averageLuma = lumaSum / pixelCount;
    const ok = averageLuma > 1.5 || (maxLuma > 32 && activePixels >= 8);
    return {
      ok,
      reason: ok
        ? "visual output detected"
        : `blank or too dark: avg=${averageLuma.toFixed(2)} max=${maxLuma.toFixed(0)} active=${activePixels}`,
      activePixels,
      averageLuma,
      maxLuma,
    };
  } catch (error) {
    return { ok: false, reason: `canvas read failed: ${String(error)}`, activePixels: 0, averageLuma: 0, maxLuma: 0 };
  } finally {
    probe.remove();
  }
}

export async function validateSceneVisual(
  sceneType: Exclude<SceneType, "video">,
  code: string,
  audio: AudioAnalysis,
): Promise<VisualValidationResult> {
  const renderer = await createRenderer(sceneType);
  if (!renderer) {
    return { ok: false, reason: `renderer unavailable for ${sceneType}`, activePixels: 0, averageLuma: 0, maxLuma: 0 };
  }

  const canvas = document.createElement("canvas");
  canvas.width = VALIDATION_W;
  canvas.height = VALIDATION_H;

  try {
    renderer.init(canvas);
    renderer.setCode(code);
    await waitFrame();

    let best = analyzeCanvas(canvas);
    for (let frame = 0; frame < FRAMES_TO_TEST; frame++) {
      renderer.update(frame / 60, 1 / 60, audio);
      await waitFrame();
      const result = analyzeCanvas(canvas);
      if (result.ok) return result;
      if (result.maxLuma > best.maxLuma || result.averageLuma > best.averageLuma) {
        best = result;
      }
    }
    return best;
  } catch (error) {
    return { ok: false, reason: `render failed: ${String(error)}`, activePixels: 0, averageLuma: 0, maxLuma: 0 };
  } finally {
    renderer.destroy();
    canvas.remove();
  }
}
