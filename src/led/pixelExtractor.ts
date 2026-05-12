import { ledSendColors } from "./commands";
import { GpuPixelSampler } from "./gpuPixelSampler";
import type { CalibrationPoint, LedConfig } from "../types";

let gpuSampler: GpuPixelSampler | null | undefined;

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

  for (const point of points) {
    const px = Math.round(point.x * (canvasWidth - 1));
    const py = Math.round(point.y * (canvasHeight - 1));
    const data = ctx.getImageData(px, py, 1, 1).data;
    const br = applyBrightnessCurve(data[0] * config.brightness, config.colorGain[0]);
    const bg = applyBrightnessCurve(data[1] * config.brightness, config.colorGain[1]);
    const bb = applyBrightnessCurve(data[2] * config.brightness, config.colorGain[2]);

    colors.set(point.lanternId, [
      Math.min(255, br),
      Math.min(255, bg),
      Math.min(255, bb),
    ]);
  }

  return colors;
}

export function extractPixelColorsGpu(
  canvas: HTMLCanvasElement,
  points: CalibrationPoint[],
  config: LedConfig,
): Map<number, [number, number, number]> | null {
  if (gpuSampler === undefined) {
    try {
      gpuSampler = new GpuPixelSampler();
    } catch {
      gpuSampler = null;
    }
  }
  return gpuSampler?.sample(canvas, points, config) ?? null;
}

export async function sendLedFrameFromCanvas(
  canvas: HTMLCanvasElement | null,
  points: CalibrationPoint[],
  config: LedConfig,
): Promise<void> {
  if (!canvas || !config.enabled || points.length === 0) return;

  const ctx = canvas.getContext("2d");
  const colors = extractPixelColorsGpu(canvas, points, config)
    ?? (ctx ? extractPixelColors(ctx, canvas.width, canvas.height, points, config) : null);
  if (!colors || colors.size === 0) return;

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
