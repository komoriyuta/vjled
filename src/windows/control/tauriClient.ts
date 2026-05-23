import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { availableMonitors, PhysicalPosition, PhysicalSize, type Monitor } from "@tauri-apps/api/window";

export async function chooseProjectSavePath(): Promise<string | null> {
  const selected = await open({
    multiple: false,
    filters: [{ name: "Project", extensions: ["vjled.json"] }],
    defaultPath: "project.vjled.json",
  });
  return typeof selected === "string" ? selected : null;
}

export async function chooseProjectLoadPath(): Promise<string | null> {
  const selected = await open({
    multiple: false,
    filters: [{ name: "Project", extensions: ["vjled.json", "json"] }],
  });
  return typeof selected === "string" ? selected : null;
}

export async function chooseVideoPath(): Promise<string | null> {
  const selected = await open({
    multiple: false,
    filters: [{ name: "Video", extensions: ["mp4", "webm", "mov", "avi", "mkv", "ogv"] }],
  });
  return typeof selected === "string" ? selected : null;
}

export async function chooseLayoutPath(): Promise<string | null> {
  const selected = await open({
    multiple: false,
    filters: [{ name: "Hardware Layout", extensions: ["json"] }],
  });
  return typeof selected === "string" ? selected : null;
}

export function saveProject(path: string, data: unknown): Promise<void> {
  return invoke("project_save", { path, data });
}

export function loadProjectFile<T>(path: string): Promise<T> {
  return invoke<T>("project_load", { path });
}

export interface NativeGpuDiagnostics {
  renderer: string;
  vendor: string;
  directRendering: boolean | null;
  source: string;
}

export function getNativeGpuDiagnostics(): Promise<NativeGpuDiagnostics> {
  return invoke<NativeGpuDiagnostics>("native_gpu_diagnostics");
}

export async function resolveVideoUrl(path: string): Promise<string> {
  const port = await invoke<number>("get_video_server_port");
  return `http://127.0.0.1:${port}/${path}`;
}

export async function toggleOutputDecorations(): Promise<boolean | null> {
  const output = await WebviewWindow.getByLabel("output");
  if (!output) return null;

  const current = await output.isDecorated();
  const next = !current;
  await Promise.all((await getOutputWindows()).map((window) => window.setDecorations(next)));
  return next;
}

export type OutputMonitor = {
  id: string;
  index: number;
  name: string;
  label: string;
  size: { width: number; height: number };
  position: { x: number; y: number };
  scaleFactor: number;
};

function toOutputMonitor(monitor: Monitor, index: number): OutputMonitor {
  const name = monitor.name ?? `Monitor ${index + 1}`;
  const sizeLabel = `${monitor.size.width}x${monitor.size.height}`;
  const positionLabel = `${monitor.position.x},${monitor.position.y}`;
  return {
    id: `${index}:${name}:${positionLabel}:${sizeLabel}`,
    index,
    name,
    label: `${index + 1}. ${name} (${sizeLabel} @ ${positionLabel})`,
    size: { width: monitor.size.width, height: monitor.size.height },
    position: { x: monitor.position.x, y: monitor.position.y },
    scaleFactor: monitor.scaleFactor,
  };
}

export async function listOutputMonitors(): Promise<OutputMonitor[]> {
  const monitors = await availableMonitors();
  return monitors.map(toOutputMonitor);
}

export async function moveOutputToMonitor(monitor: OutputMonitor, fitToMonitor = false): Promise<void> {
  const output = await WebviewWindow.getByLabel("output");
  if (!output) throw new Error("Output window was not found.");

  await placeOutputWindow(output, monitor, fitToMonitor);
}

function outputWindowLabel(index: number): string {
  return index === 0 ? "output" : `output-monitor-${index}`;
}

function isOutputWindowLabel(label: string): boolean {
  return label === "output" || label.startsWith("output-monitor-");
}

async function getOutputWindows(): Promise<WebviewWindow[]> {
  const windows = await WebviewWindow.getAll();
  return windows.filter((window) => isOutputWindowLabel(window.label));
}

async function getOrCreateOutputWindow(label: string): Promise<WebviewWindow> {
  const existing = await WebviewWindow.getByLabel(label);
  if (existing) return existing;

  const output = new WebviewWindow(label, {
    url: "/output.html",
    title: label === "output" ? "VJLED - Output" : `VJLED - Output ${label.replace("output-monitor-", "")}`,
    width: 1280,
    height: 720,
    decorations: false,
    resizable: true,
    transparent: false,
    visible: false,
  });

  await new Promise<void>((resolve, reject) => {
    output.once("tauri://created", () => resolve()).catch(reject);
    output.once("tauri://error", (event) => reject(new Error(String(event.payload)))).catch(reject);
  });

  return output;
}

async function placeOutputWindow(output: WebviewWindow, monitor: OutputMonitor, fitToMonitor: boolean): Promise<void> {
  await output.setFullscreen(false);
  await output.setPosition(new PhysicalPosition(monitor.position.x, monitor.position.y));
  if (fitToMonitor) {
    await output.setSize(new PhysicalSize(monitor.size.width, monitor.size.height));
  }
  await output.show();
  await output.unminimize();
  await output.setFocus();
}

export async function assignOutputsToMonitors(monitors: OutputMonitor[], fitToMonitor = true, availableMonitorsForCleanup: OutputMonitor[] = monitors): Promise<void> {
  if (monitors.length === 0) throw new Error("Select at least one monitor.");

  const selectedLabels = new Set(monitors.map((_, selectedIndex) => outputWindowLabel(selectedIndex)));

  await Promise.all(monitors.map(async (monitor, selectedIndex) => {
    const output = await getOrCreateOutputWindow(outputWindowLabel(selectedIndex));
    await placeOutputWindow(output, monitor, fitToMonitor);
  }));

  const possibleLabels = availableMonitorsForCleanup.map((_, index) => outputWindowLabel(index));
  const extraLabels = new Set(possibleLabels.filter((label) => !selectedLabels.has(label)));
  await Promise.all((await getOutputWindows()).map(async (output) => {
    if (output.label !== "output" && (extraLabels.has(output.label) || !selectedLabels.has(output.label))) await output.destroy();
  }));
}

export async function closeOutputWindows(): Promise<void> {
  await Promise.all((await getOutputWindows()).map((output) => output.destroy()));
}
