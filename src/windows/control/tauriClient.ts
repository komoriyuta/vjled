import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

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

export function saveProject(path: string, data: unknown): Promise<void> {
  return invoke("project_save", { path, data });
}

export function loadProjectFile<T>(path: string): Promise<T> {
  return invoke<T>("project_load", { path });
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
  await output.setDecorations(next);
  return next;
}

export async function openLedMappingWindow(): Promise<"focused" | "opening"> {
  const existing = await WebviewWindow.getByLabel("led-mapping");
  if (existing) {
    await existing.show();
    await existing.unminimize();
    await existing.setFocus();
    return "focused";
  }

  const win = new WebviewWindow("led-mapping", {
    url: "/led-mapping.html",
    title: "VJLED - LED Calibration",
    width: 1280,
    height: 720,
    decorations: true,
    resizable: true,
    focus: true,
  });

  return new Promise((resolve, reject) => {
    win.once("tauri://created", () => resolve("opening"));
    win.once("tauri://error", (event) => reject(event.payload));
  });
}
