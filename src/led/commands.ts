import { invoke } from "@tauri-apps/api/core";
import type { LayoutInfo } from "../types";

export async function ledLoadLayout(path: string): Promise<LayoutInfo> {
  return invoke("led_load_layout", { path });
}

export async function ledInitSimple(
  broadcastIp: string,
  port: number,
  deviceId: number,
  pixelCount: number,
): Promise<LayoutInfo> {
  return invoke("led_init_simple", { broadcastIp, port, deviceId, pixelCount });
}

export async function ledSendColors(
  colors: Record<number, [number, number, number]>,
): Promise<void> {
  return invoke("led_send_colors", { colors });
}

export async function ledFill(r: number, g: number, b: number): Promise<void> {
  return invoke("led_fill", { r, g, b });
}

export async function ledSetPixel(
  lanternId: number,
  r: number,
  g: number,
  b: number,
): Promise<void> {
  return invoke("led_set_pixel", { lanternId, r, g, b });
}

export async function ledAllOff(): Promise<void> {
  return invoke("led_all_off");
}

export async function ledPing(): Promise<void> {
  return invoke("led_ping");
}

export async function ledLayoutInfo(): Promise<LayoutInfo> {
  return invoke("led_layout_info");
}

export async function calibrationSetBaseline(
  rgbaData: number[],
  width: number,
  height: number,
): Promise<void> {
  return invoke("calibration_set_baseline", { rgbaData, width, height });
}

export async function calibrationDetectLed(
  rgbaData: number[],
  width: number,
  height: number,
): Promise<[number, number] | null> {
  return invoke("calibration_detect_led", { rgbaData, width, height });
}

export async function calibrationHasBaseline(): Promise<boolean> {
  return invoke("calibration_has_baseline");
}

export async function calibrationReset(): Promise<void> {
  return invoke("calibration_reset");
}
