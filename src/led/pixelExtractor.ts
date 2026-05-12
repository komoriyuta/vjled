import { ledSendColors } from "./commands";
import { GpuPixelSampler } from "./gpuPixelSampler";
import type { CalibrationPoint, LedConfig } from "../types";

let gpuSampler: GpuPixelSampler | null | undefined;
const FULL_FRAME_READ_THRESHOLD = 96;

function clampByte(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(255, Math.round(value)));
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export function applyBrightnessCurve(
  value: number,
  factor: number,
): number {
  const normalized = value / 255;
  const curved = Math.max(0, Math.min(1, normalized * factor));
  return clampByte(curved * curved * 255);
}

function setColor(
  colors: Map<number, [number, number, number]>,
  lanternId: number,
  r: number,
  g: number,
  b: number,
  config: LedConfig,
): void {
  colors.set(lanternId, [
    applyBrightnessCurve(r * config.brightness, config.colorGain[0]),
    applyBrightnessCurve(g * config.brightness, config.colorGain[1]),
    applyBrightnessCurve(b * config.brightness, config.colorGain[2]),
  ]);
}

export function extractPixelColors(
  ctx: CanvasRenderingContext2D,
  canvasWidth: number,
  canvasHeight: number,
  points: CalibrationPoint[],
  config: LedConfig,
): Map<number, [number, number, number]> {
  const colors = new Map<number, [number, number, number]>();
  if (points.length === 0 || canvasWidth <= 0 || canvasHeight <= 0) return colors;

  if (points.length >= FULL_FRAME_READ_THRESHOLD) {
    const imageData = ctx.getImageData(0, 0, canvasWidth, canvasHeight);
    const data = imageData.data;
    for (const point of points) {
      const px = Math.round(clampUnit(point.x) * (canvasWidth - 1));
      const py = Math.round(clampUnit(point.y) * (canvasHeight - 1));
      const offset = (py * canvasWidth + px) * 4;
      setColor(
        colors,
        point.lanternId,
        data[offset],
        data[offset + 1],
        data[offset + 2],
        config,
      );
    }
    return colors;
  }

  for (const point of points) {
    const px = Math.round(clampUnit(point.x) * (canvasWidth - 1));
    const py = Math.round(clampUnit(point.y) * (canvasHeight - 1));
    const data = ctx.getImageData(px, py, 1, 1).data;
    setColor(colors, point.lanternId, data[0], data[1], data[2], config);
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
  try {
    return gpuSampler?.sample(canvas, points, config) ?? null;
  } catch {
    gpuSampler?.destroy();
    gpuSampler = null;
    return null;
  }
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
  const ctx = canvas.getContext("2d");
  if (!ctx) return { data: [], width: canvas.width, height: canvas.height };
  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return {
    data: Array.from(imgData.data),
    width: canvas.width,
    height: canvas.height,
  };
}
