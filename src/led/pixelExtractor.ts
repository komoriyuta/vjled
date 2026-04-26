import { ledSendColors } from "./commands";
import type { CalibrationPoint, LedConfig } from "../types";

export function applyBrightnessCurve(
  value: number,
  factor: number,
): number {
  const normalized = value / 255;
  const curved = Math.min(1.0, normalized * factor);
  return Math.round(curved * curved * 255);
}

export function extractPixelColors(
  ctx: CanvasRenderingContext2D,
  canvasWidth: number,
  canvasHeight: number,
  points: CalibrationPoint[],
  config: LedConfig,
): Map<number, [number, number, number]> {
  const colors = new Map<number, [number, number, number]>();
  if (points.length === 0) return colors;

  const imageData = ctx.getImageData(0, 0, canvasWidth, canvasHeight);
  const data = imageData.data;

  for (const point of points) {
    const px = Math.round(point.x * (canvasWidth - 1));
    const py = Math.round(point.y * (canvasHeight - 1));
    const idx = (py * canvasWidth + px) * 4;

    if (idx >= 0 && idx + 2 < data.length) {
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];

      const br = applyBrightnessCurve(r * config.brightness, config.colorGain[0]);
      const bg = applyBrightnessCurve(g * config.brightness, config.colorGain[1]);
      const bb = applyBrightnessCurve(b * config.brightness, config.colorGain[2]);

      colors.set(point.lanternId, [
        Math.min(255, br),
        Math.min(255, bg),
        Math.min(255, bb),
      ]);
    }
  }

  return colors;
}

export async function sendLedFrame(
  ctx: CanvasRenderingContext2D | null,
  canvasWidth: number,
  canvasHeight: number,
  points: CalibrationPoint[],
  config: LedConfig,
): Promise<void> {
  if (!ctx || !config.enabled || points.length === 0) return;

  const colors = extractPixelColors(ctx, canvasWidth, canvasHeight, points, config);
  if (colors.size === 0) return;

  const colorObj: Record<number, [number, number, number]> = {};
  for (const [k, v] of colors) {
    colorObj[k] = v;
  }

  try {
    await ledSendColors(colorObj);
  } catch {
    // silently ignore send errors during real-time operation
  }
}

export function rgbaFromCanvas(
  canvas: HTMLCanvasElement,
): { data: number[]; width: number; height: number } {
  const ctx = canvas.getContext("2d")!;
  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return {
    data: Array.from(imgData.data),
    width: canvas.width,
    height: canvas.height,
  };
}
