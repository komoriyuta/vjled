import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import Editor from "@monaco-editor/react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useAiStore } from "../../stores/aiStore";
import { useLedStore } from "../../stores/ledStore";
import { emptyAudioAnalysis, useVJStore } from "../../stores/vjStore";
import { createRenderer } from "../../renderers";
import { emitLedState, emitVJAudio, emitVJRuntime, emitVJState, listenLedState, listenLedStateRequest, listenVJStateRequest } from "../../events/vjEvents";
import {
  calibrationDetectLed,
  calibrationReset,
  calibrationSetBaseline,
  ledAllOff,
  ledFill,
  ledInitSimple,
  ledLoadLayout,
  ledLoadLayoutJson,
  ledSetPixel,
} from "../../led/commands";
import { attachCameraStream, listCalibrationCameras, startCalibrationCamera, type CameraDevice } from "../../led/camera";
import { mapCameraToVideo } from "../../led/mapping";
import { rgbaFromCanvas } from "../../led/pixelExtractor";
import { listAudioDevices, type RustAudioDevice, useAudioAnalysis } from "../../hooks/useAudioAnalysis";
import { useEngine } from "../../hooks/useEngine";
import { createProjectData, parseProjectData } from "../../project";
import type { AudioAnalysis, BusLabel, CalibrationPoint, LayoutInfo, LedConfig, MappingHandle, MixMode, MixSettings, Scene, SceneKeySettings, SceneType, VideoSync } from "../../types";
import {
  chooseProjectLoadPath,
  chooseProjectSavePath,
  chooseVideoPath,
  assignOutputsToMonitors,
  closeOutputWindows,
  getNativeGpuDiagnostics,
  listOutputMonitors,
  loadProjectFile,
  type OutputMonitor,
  type NativeGpuDiagnostics,
  resolveVideoUrl,
  saveProject,
  toggleOutputDecorations as toggleTauriOutputDecorations,
} from "./tauriClient";
import "./control.css";

const typeColors: Record<SceneType, string> = {
  glsl: "#ef4444",
  p5: "#38bdf8",
  threejs: "#34d399",
  video: "#f59e0b",
};

type Workspace = "perform" | "project" | "output" | "audio" | "ai" | "led";

type GenerativeSceneType = Exclude<SceneType, "video">;
type AutoSceneType = GenerativeSceneType | "auto";

interface AutoVJSettings {
  enabled: boolean;
  sceneType: AutoSceneType;
  intervalBars: number;
  decisionSeconds: number;
  minSceneSeconds: number;
  generateCooldownSeconds: number;
  transitionSeconds: number;
  maxScenes: number;
}

interface AudioMood {
  label: string;
  tags: string;
  energy: number;
  bass: number;
  mid: number;
  treble: number;
  palette: string;
  motion: string;
  texture: string;
}

interface AutoVJStatus {
  mood: AudioMood;
  lastAction: string;
  nextTrigger: string;
}

interface AutoVJLogEntry {
  id: number;
  time: string;
  kind: AutoVJAction | "TRIGGER" | "GUARD" | "ERROR";
  message: string;
}

type AutoVJAction = "KEEP" | "ACCENT" | "SWITCH" | "GENERATE";

interface AutoVJDecision {
  action: AutoVJAction;
  confidence: number;
  reason: string;
  targetSceneId?: string;
  visualDirection?: string;
}

interface WebGLDiagnostics {
  supported: boolean;
  renderer: string;
  vendor: string;
  accelerated: boolean;
  suspicious: boolean;
}

interface AudioSnapshot {
  at: number;
  bpm: number;
  beat: boolean;
  beatCount: number;
  energy: number;
  bass: number;
  mid: number;
  treble: number;
  tags: { label: string; confidence: number }[];
}

interface AudioSummary {
  windowSeconds: number;
  current: AudioSnapshot;
  averageEnergy: number;
  energyDelta: number;
  bpm: number;
  bpmStable: boolean;
  topTags: { label: string; confidence: number }[];
  risingTags: string[];
  fadingTags: string[];
}

const defaultAutoVJ: AutoVJSettings = {
  enabled: false,
  sceneType: "auto",
  intervalBars: 16,
  decisionSeconds: 30,
  minSceneSeconds: 30,
  generateCooldownSeconds: 30,
  transitionSeconds: 4,
  maxScenes: 9,
};

const maxActiveRenderedScenes = 4;
const sceneTypeRotation: GenerativeSceneType[] = ["glsl", "threejs", "p5"];

const mixLabels: Record<MixMode, string> = {
  crossfade: "Crossfade",
  additive: "Add",
  screen: "Screen",
  multiply: "Multiply",
  overlay: "Overlay",
  softLight: "Soft Light",
  difference: "Difference",
  lighten: "Lighten",
  darken: "Darken",
  wipeLeft: "Wipe L",
  wipeRight: "Wipe R",
  wipeUp: "Wipe U",
  wipeDown: "Wipe D",
  circle: "Circle",
  diamond: "Diamond",
  dissolve: "Dissolve",
  luma: "Luma",
  ripple: "Ripple",
  glitch: "Glitch",
  rgbSplit: "RGB Split",
};

const blendModes: MixMode[] = ["crossfade", "additive", "screen", "overlay"];
const transitionModes: MixMode[] = ["glitch", "rgbSplit", "luma"];

const defaultSceneKey: SceneKeySettings = {
  enabled: false,
  threshold: 0.08,
  softness: 0.08,
  spill: 0.2,
};

function clampMs(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(5000, Math.round(value)));
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMapHandles(value: unknown): MappingHandle[] | null {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const handles = value.map((item) => {
    if (!Array.isArray(item) || item.length !== 2) return null;
    const x = Number(item[0]);
    const y = Number(item[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return [Math.max(0, Math.min(1, x)), Math.max(0, Math.min(1, y))] as MappingHandle;
  });
  return handles.every(Boolean) ? handles as MappingHandle[] : null;
}

function parseMapPoints(value: unknown): CalibrationPoint[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const lanternId = Number(item.lanternId);
    const x = Number(item.x);
    const y = Number(item.y);
    if (!Number.isFinite(lanternId) || !Number.isFinite(x) || !Number.isFinite(y)) return [];
    return [{ lanternId: Math.max(0, Math.round(lanternId)), x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) }];
  });
}

function parseLayoutSnapshot(value: unknown): LayoutInfo | null {
  if (!isRecord(value) || !Array.isArray(value.devices)) return null;
  const devices = value.devices.flatMap((device) => {
    if (!isRecord(device)) return [];
    return [{
      key: typeof device.key === "string" ? device.key : "",
      device_id: Math.max(0, Math.round(Number(device.device_id) || 0)),
      total_pixels: Math.max(0, Math.round(Number(device.total_pixels) || 0)),
      controller_ip: typeof device.controller_ip === "string" ? device.controller_ip : "",
    }];
  });
  return {
    total_pixels: Math.max(0, Math.round(Number(value.total_pixels) || 0)),
    device_count: Math.max(0, Math.round(Number(value.device_count) || devices.length)),
    devices,
  };
}

function parseLedMapExport(raw: unknown): {
  config?: Partial<LedConfig>;
  layoutInfo: LayoutInfo | null;
  mappingHandles: MappingHandle[];
  rawCameraPoints: CalibrationPoint[];
  calibrationPoints: CalibrationPoint[];
} {
  const led = isRecord(raw) && isRecord(raw.led) ? raw.led : raw;
  if (!isRecord(led)) throw new Error("LED map file is not a JSON object");
  const mappingHandles = parseMapHandles(led.mappingHandles);
  if (!mappingHandles) throw new Error("LED map file does not contain valid mappingHandles");
  return {
    config: isRecord(led.config) ? led.config as Partial<LedConfig> : undefined,
    layoutInfo: parseLayoutSnapshot(led.layoutInfo),
    mappingHandles,
    rawCameraPoints: parseMapPoints(led.rawCameraPoints),
    calibrationPoints: parseMapPoints(led.calibrationPoints),
  };
}

function readWebGLDiagnostics(): WebGLDiagnostics {
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
  if (!gl) {
    return {
      supported: false,
      renderer: "WebGL unavailable",
      vendor: "unknown",
      accelerated: false,
      suspicious: false,
    };
  }

  const debug = gl.getExtension("WEBGL_debug_renderer_info");
  const vendor = debug
    ? String(gl.getParameter(debug.UNMASKED_VENDOR_WEBGL))
    : String(gl.getParameter(gl.VENDOR));
  const renderer = debug
    ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL))
    : String(gl.getParameter(gl.RENDERER));
  const lower = `${vendor} ${renderer}`.toLowerCase();
  return {
    supported: true,
    vendor,
    renderer,
    accelerated: !/(swiftshader|llvmpipe|softpipe|software rasterizer|mesa offscreen)/i.test(lower),
    suspicious: navigator.platform.toLowerCase().includes("linux") && lower.includes("apple"),
  };
}

export default function ControlApp() {
  const scenes = useVJStore((s) => s.scenes);
  const busA = useVJStore((s) => s.busA);
  const busB = useVJStore((s) => s.busB);
  const crossfade = useVJStore((s) => s.crossfade);
  const mix = useVJStore((s) => s.mix);
  const isPlaying = useVJStore((s) => s.isPlaying);
  const selectedSceneId = useVJStore((s) => s.selectedSceneId);
  const addScene = useVJStore((s) => s.addScene);
  const removeScene = useVJStore((s) => s.removeScene);
  const updateSceneCode = useVJStore((s) => s.updateSceneCode);
  const setSceneRenderPaused = useVJStore((s) => s.setSceneRenderPaused);
  const setBusA = useVJStore((s) => s.setBusA);
  const setBusB = useVJStore((s) => s.setBusB);
  const setCrossfade = useVJStore((s) => s.setCrossfade);
  const setMixSettings = useVJStore((s) => s.setMixSettings);
  const setSceneKey = useVJStore((s) => s.setSceneKey);
  const renameScene = useVJStore((s) => s.renameScene);
  const cutToA = useVJStore((s) => s.cutToA);
  const cutToB = useVJStore((s) => s.cutToB);
  const fadeToA = useVJStore((s) => s.fadeToA);
  const fadeToB = useVJStore((s) => s.fadeToB);
  const setPlaying = useVJStore((s) => s.setPlaying);
  const selectScene = useVJStore((s) => s.selectScene);
  const setVideoSync = useVJStore((s) => s.setVideoSync);

  useAudioAnalysis();
  const [audio, setAudioForUi] = useState(() => useVJStore.getState().audio);

  useEffect(() => {
    return useVJStore.subscribe((state, previous) => {
      if (state.audio === previous.audio) return;
      setAudioForUi(state.audio);
    });
  }, []);

  const loadProject = useVJStore((s) => s.loadProject);
  const setAudioEnabled = useVJStore((s) => s.setAudioEnabled);
  const setAudioDevice = useVJStore((s) => s.setAudioDevice);
  const ledLoadProject = useLedStore((s) => s.loadProject);

  const outputPreviewRef = useRef<HTMLDivElement>(null);
  const busACanvasRef = useRef<HTMLCanvasElement>(null);
  const busBCanvasRef = useRef<HTMLCanvasElement>(null);
  const selectedCanvasRef = useRef<HTMLCanvasElement>(null);
  const contextSelectedCanvasRef = useRef<HTMLCanvasElement>(null);
  const codeSelectedCanvasRef = useRef<HTMLCanvasElement>(null);
  const scenePreviewCanvasesRef = useRef<Map<string, HTMLCanvasElement | null>>(new Map());
  const selectedPreviewRefs = useMemo(
    () => [contextSelectedCanvasRef, codeSelectedCanvasRef],
    [],
  );

  const [workspace, setWorkspace] = useState<Workspace>("perform");
  const [outputDecorated, setOutputDecorated] = useState(false);
  const [webglDiagnostics, setWebglDiagnostics] = useState<WebGLDiagnostics | null>(null);
  const [nativeGpuDiagnostics, setNativeGpuDiagnostics] = useState<NativeGpuDiagnostics | null>(null);
  const [autoVJ, setAutoVJ] = useState<AutoVJSettings>(defaultAutoVJ);
  const [autoStatus, setAutoStatus] = useState<AutoVJStatus>(() => ({
    mood: analyzeAudioMood(emptyAudioAnalysis),
    lastAction: "Idle",
    nextTrigger: "Waiting for audio",
  }));
  const [autoLog, setAutoLog] = useState<AutoVJLogEntry[]>([]);
  const autoBusyRef = useRef(false);
  const autoLastBeatRef = useRef(0);
  const autoLastWallTriggerRef = useRef(0);
  const autoLastDecisionAtRef = useRef(0);
  const autoLastGenerateAtRef = useRef(0);
  const autoSceneStartedAtRef = useRef(0);
  const autoAudioHistoryRef = useRef<AudioSnapshot[]>([]);
  const autoLastSnapshotAtRef = useRef(0);
  const autoLastStatusAtRef = useRef(0);
  const autoPrimedRef = useRef(false);
  const clockStartedAtRef = useRef(performance.now());

  const aiConfig = useAiStore((s) => s.config);
  const aiGenerating = useAiStore((s) => s.generating);
  const aiError = useAiStore((s) => s.error);
  const aiSetConfig = useAiStore((s) => s.setConfig);
  const aiGenerate = useAiStore((s) => s.generate);
  const aiDecideAutoVJ = useAiStore((s) => s.decideAutoVJ);

  useEffect(() => {
    const diagnostics = readWebGLDiagnostics();
    setWebglDiagnostics(diagnostics);
    console.info("[VJLED] WebGL diagnostics", diagnostics);
    getNativeGpuDiagnostics()
      .then((nativeDiagnostics) => {
        setNativeGpuDiagnostics(nativeDiagnostics);
        console.info("[VJLED] Native GPU diagnostics", nativeDiagnostics);
      })
      .catch((error) => console.warn("[VJLED] Native GPU diagnostics unavailable", error));
  }, []);

  const { sendCommand, getVideoInfo } = useEngine({
    outputContainerRef: outputPreviewRef,
    preview: true,
    busAPreviewRef: busACanvasRef,
    busBPreviewRef: busBCanvasRef,
    selectedPreviewRef: selectedCanvasRef,
    selectedPreviewRefs,
    scenePreviewCanvasesRef,
  });

  const selectedScene = scenes.find((s) => s.id === selectedSceneId) ?? null;
  const busAScene = scenes.find((s) => s.id === busA);
  const busBScene = scenes.find((s) => s.id === busB);

  const appendAutoLog = useCallback((kind: AutoVJLogEntry["kind"], message: string) => {
    const now = new Date();
    const entry: AutoVJLogEntry = {
      id: now.getTime() + Math.floor(Math.random() * 1000),
      time: now.toLocaleTimeString([], { hour12: false }),
      kind,
      message,
    };
    setAutoLog((current) => [entry, ...current].slice(0, 80));
    console.info(`[AutoVJ] ${entry.time} ${kind}: ${message}`);
  }, []);

  const handleSave = useCallback(async () => {
    try {
      const path = await chooseProjectSavePath();
      if (!path) return;
      const state = useVJStore.getState();
      const led = useLedStore.getState();
      const ai = useAiStore.getState();
      await saveProject(path, createProjectData({
        vj: state,
        led: {
          config: led.config,
          calibrationPoints: led.calibrationPoints,
          layoutInfo: led.layoutInfo,
          mappingHandles: led.mappingHandles,
          rawCameraPoints: led.rawCameraPoints,
        },
        ai: {
          baseUrl: ai.config.baseUrl,
          model: ai.config.model,
        },
      }));
    } catch (e) {
      console.error("Save failed:", e);
    }
  }, []);

  const handleLoad = useCallback(async () => {
    try {
      const path = await chooseProjectLoadPath();
      if (!path) return;
      const rawProject = await loadProjectFile<unknown>(path);
      const project = parseProjectData(rawProject, useLedStore.getState().config);
      loadProject(project.vj);
      ledLoadProject(project.led.config, project.led.calibrationPoints, project.led.layoutInfo, project.led.mappingHandles, project.led.rawCameraPoints);
      emitLedState({
        source: "control",
        config: project.led.config,
        calibrationPoints: project.led.calibrationPoints,
        layoutInfo: project.led.layoutInfo,
        mappingHandles: project.led.mappingHandles,
        rawCameraPoints: project.led.rawCameraPoints,
        connected: false,
      });
      if (project.ai) aiSetConfig(project.ai);
    } catch (e) {
      console.error("Load failed:", e);
    }
  }, [loadProject, ledLoadProject, aiSetConfig]);

  const handleAiGenerate = useCallback(
    async (sceneType: SceneType, prompt: string) => {
      try {
        const code = await generateVisuallyValidCode(aiGenerate, sceneType, addGenreHint(prompt, audio), undefined, audio);
        addScene(sceneType);
        const currentScenes = useVJStore.getState().scenes;
        const nextScene = currentScenes[currentScenes.length - 1];
        if (nextScene) {
          updateSceneCode(nextScene.id, code);
          selectScene(nextScene.id);
        }
      } catch {}
    },
    [aiGenerate, addScene, audio, updateSceneCode, selectScene],
  );

  const handleAiEdit = useCallback(
    async (prompt: string) => {
      if (!selectedScene) return;
      try {
        const code = await generateVisuallyValidCode(aiGenerate, selectedScene.type, addGenreHint(prompt, audio), selectedScene.code, audio);
        updateSceneCode(selectedScene.id, code);
      } catch {}
    },
    [aiGenerate, audio, selectedScene, updateSceneCode],
  );

  const updateAutoVJ = useCallback((patch: Partial<AutoVJSettings>) => {
    setAutoVJ((current) => {
      const next = { ...current, ...patch };
      if (patch.enabled !== undefined || patch.intervalBars !== undefined || patch.decisionSeconds !== undefined || patch.sceneType !== undefined) {
        autoLastBeatRef.current = 0;
        autoLastWallTriggerRef.current = 0;
        autoLastDecisionAtRef.current = 0;
        autoPrimedRef.current = false;
      }
      if (patch.enabled !== undefined) {
        appendAutoLog("TRIGGER", patch.enabled ? "Auto VJ enabled; waiting for audio/beat trigger" : "Auto VJ disabled");
      }
      return next;
    });
  }, [appendAutoLog]);

  const runAutoVJCycle = useCallback(
    async (reason: string, mood: AudioMood) => {
      if (autoBusyRef.current || !autoVJ.enabled || !aiConfig.apiKey) return;
      const now = performance.now();
      const summary = summarizeAudioHistory(autoAudioHistoryRef.current, mood);
      const sceneAgeSeconds = autoSceneStartedAtRef.current > 0 ? (now - autoSceneStartedAtRef.current) / 1000 : Number.POSITIVE_INFINITY;
      const generateCooldownSeconds = autoLastGenerateAtRef.current > 0 ? (now - autoLastGenerateAtRef.current) / 1000 : Number.POSITIVE_INFINITY;
      appendAutoLog("TRIGGER", `${reason}; mood=${mood.label}; tags=${formatTagList(summary.topTags)}; energy=${summary.current.energy.toFixed(2)} delta=${summary.energyDelta.toFixed(2)}; sceneAge=${formatAge(sceneAgeSeconds)}; genCooldown=${formatAge(generateCooldownSeconds)}`);
      autoBusyRef.current = true;
      setAutoStatus((s) => ({
        ...s,
        mood,
        lastAction: `Directing ${mood.label.toLowerCase()}`,
      }));

      try {
        const prompt = buildAutoDecisionPrompt({
          reason,
          mood,
          summary,
          sceneAgeSeconds,
          generateCooldownSeconds,
          minSceneSeconds: autoVJ.minSceneSeconds,
          generateCooldownLimitSeconds: autoVJ.generateCooldownSeconds,
          scenes: useVJStore.getState().scenes,
          busA: useVJStore.getState().busA,
          busB: useVJStore.getState().busB,
        });
        const rawDecision = await aiDecideAutoVJ(prompt);
        const parsedDecision = parseAutoVJDecision(rawDecision);
        let decision = normalizeAutoVJDecision(parsedDecision, summary, sceneAgeSeconds, generateCooldownSeconds, autoVJ);
        appendAutoLog(decision.action, `director=${String(parsedDecision.action ?? "KEEP").toUpperCase()} -> ${decision.action}; conf=${decision.confidence.toFixed(2)}; ${decision.reason}`);
        const currentState = useVJStore.getState();
        const hasPlayableScene = currentState.scenes.some((scene) => scene.type !== "video" && !scene.renderPaused);
        const canGenerateNow = shouldAutoGenerate(sceneAgeSeconds, generateCooldownSeconds, autoVJ);
        const parseFailed = decision.reason.includes("non-json") || decision.reason.includes("parse failed");
        if (!hasPlayableScene || (!currentState.busA && !currentState.busB)) {
          decision = {
            ...decision,
            action: "GENERATE",
            reason: hasPlayableScene ? "no scene is assigned to output" : "no generated scene exists",
          };
          appendAutoLog("GUARD", `forced GENERATE: ${decision.reason}`);
        } else if (parseFailed && canGenerateNow) {
          decision = {
            ...decision,
            action: "GENERATE",
            confidence: Math.max(decision.confidence, 0.5),
            reason: "director JSON failed and current scene is stale",
            visualDirection: `Refresh ${mood.label} using stable tags: ${formatTagList(summary.topTags)}`,
          };
          appendAutoLog("GUARD", `non-json fallback to GENERATE; sceneAge=${formatAge(sceneAgeSeconds)} genCooldown=${formatAge(generateCooldownSeconds)}`);
        }
        if (decision.action === "KEEP" && canGenerateNow) {
          decision = {
            ...decision,
            action: "GENERATE",
            confidence: Math.max(decision.confidence, 0.62),
            reason: `refresh bias: ${decision.reason}`,
            visualDirection: decision.visualDirection || `Make a visibly new ${mood.label} look using ${formatTagList(summary.topTags)}`,
          };
          appendAutoLog("GUARD", `KEEP upgraded to GENERATE; sceneAge=${formatAge(sceneAgeSeconds)} genCooldown=${formatAge(generateCooldownSeconds)}`);
        } else if (decision.action === "KEEP" && sceneAgeSeconds >= autoVJ.minSceneSeconds) {
          decision = {
            ...decision,
            action: "ACCENT",
            reason: `refresh accent bias: ${decision.reason}`,
          };
          appendAutoLog("GUARD", `KEEP upgraded to ACCENT; sceneAge=${formatAge(sceneAgeSeconds)}`);
        }

        if (decision.action === "KEEP") {
          appendAutoLog("KEEP", decision.reason);
          setAutoStatus({
            mood,
            lastAction: `Keep: ${decision.reason}`,
            nextTrigger: `~${autoVJ.decisionSeconds}s`,
          });
          return;
        }

        if (decision.action === "ACCENT") {
          const mode = pickAutoMixMode(mood);
          setMixSettings({
            mode,
            intensity: Math.max(0.52, Math.min(0.95, 0.55 + summary.current.energy * 0.45)),
            feather: mood.treble > 0.55 ? 0.035 : 0.08,
          });
          setAutoStatus({
            mood,
            lastAction: `Accent: ${mixLabels[mode]} (${decision.reason})`,
            nextTrigger: `~${autoVJ.decisionSeconds}s`,
          });
          appendAutoLog("ACCENT", `${mixLabels[mode]}; intensity=${Math.max(0.52, Math.min(0.95, 0.55 + summary.current.energy * 0.45)).toFixed(2)}; ${decision.reason}`);
          return;
        }

        if (decision.action === "SWITCH") {
          const state = useVJStore.getState();
          const target = pickAutoSwitchScene(decision.targetSceneId, state.scenes, state.busA, state.busB, mood);
          if (target) {
            const mode = pickAutoMixMode(mood);
            setMixSettings({ mode, intensity: mood.energy > 0.68 ? 0.88 : 0.68, feather: mood.treble > 0.55 ? 0.04 : 0.09 });
            const liveOnA = state.crossfade < 0.5;
            if (liveOnA) {
              setBusB(target.id);
              fadeToB(autoVJ.transitionSeconds * 1000);
            } else {
              setBusA(target.id);
              fadeToA(autoVJ.transitionSeconds * 1000);
            }
            autoSceneStartedAtRef.current = now;
            setAutoStatus({
              mood,
              lastAction: `Switch: ${target.name} (${decision.reason})`,
              nextTrigger: `~${autoVJ.decisionSeconds}s`,
            });
            appendAutoLog("SWITCH", `${target.name}; mode=${mixLabels[mode]}; ${decision.reason}`);
            return;
          }
          if (canGenerateNow) {
            decision = {
              ...decision,
              action: "GENERATE",
              reason: "no available scene to switch to; generating a new alternative",
              visualDirection: decision.visualDirection || `Create an alternative ${mood.label} scene for ${formatTagList(summary.topTags)}`,
            };
            appendAutoLog("GUARD", `SWITCH fallback to GENERATE; no available matching scene`);
          } else {
          const mode = pickAutoMixMode(mood);
          setMixSettings({ mode, intensity: 0.62, feather: 0.09 });
          setAutoStatus({
            mood,
            lastAction: `Accent: no matching scene to switch`,
            nextTrigger: `~${autoVJ.decisionSeconds}s`,
          });
          appendAutoLog("GUARD", `SWITCH fallback to ACCENT; no available matching scene`);
          return;
          }
        }

        const beforeGenerate = useVJStore.getState();
        const type = pickAutoSceneType(autoVJ.sceneType, mood, beforeGenerate.scenes);
        const mode = pickAutoMixMode(mood);
        const generatePrompt = buildAutoPrompt({
          mood,
          audio: beforeGenerate.audio,
          reason: `${reason}: ${decision.visualDirection || decision.reason}`,
          sceneType: type,
          currentScenes: beforeGenerate.scenes,
        });
        const code = await generateVisuallyValidCode(aiGenerate, type, generatePrompt, undefined, beforeGenerate.audio);
        appendAutoLog("GENERATE", `code generated; type=${type}; direction=${decision.visualDirection || decision.reason}`);

        addScene(type);
        const state = useVJStore.getState();
        const generated = state.scenes[state.scenes.length - 1];
        if (!generated) return;

        const generatedName = `AI ${mood.label} ${generated.id.replace("scene-", "#")}`;
        updateSceneCode(generated.id, code);
        renameScene(generated.id, generatedName);
        selectScene(generated.id);
        setMixSettings({ mode, intensity: mood.energy > 0.68 ? 0.9 : 0.72, feather: mood.treble > 0.55 ? 0.045 : 0.09 });

        const liveOnA = state.crossfade < 0.5;
        if (liveOnA) {
          setBusB(generated.id);
          fadeToB(autoVJ.transitionSeconds * 1000);
        } else {
          setBusA(generated.id);
          fadeToA(autoVJ.transitionSeconds * 1000);
        }
        autoSceneStartedAtRef.current = now;
        autoLastGenerateAtRef.current = now;

        const after = useVJStore.getState();
        enforceRenderBudget(after.scenes, after.busA, after.busB, after.selectedSceneId, new Set([generated.id]), setSceneRenderPaused);
        const extraScenes = after.scenes.filter((scene) => scene.name.startsWith("AI "));
        if (extraScenes.length > autoVJ.maxScenes) {
          const protectedIds = new Set([after.busA, after.busB, generated.id]);
          const removable = extraScenes.find((scene) => !protectedIds.has(scene.id));
          if (removable) removeScene(removable.id);
        }

        setAutoStatus({
          mood,
            lastAction: `Generate: ${mixLabels[mode]} to ${generatedName}`,
            nextTrigger: `~${autoVJ.decisionSeconds}s`,
          });
        appendAutoLog("GENERATE", `${generatedName}; mode=${mixLabels[mode]}; bus=${liveOnA ? "B" : "A"}`);
      } catch (e) {
        appendAutoLog("ERROR", String(e));
        setAutoStatus((s) => ({
          ...s,
          mood,
          lastAction: `Auto failed: ${String(e)}`,
          nextTrigger: "Waiting for next trigger",
        }));
      } finally {
        autoBusyRef.current = false;
      }
    },
    [addScene, aiConfig.apiKey, aiDecideAutoVJ, aiGenerate, appendAutoLog, autoVJ, fadeToA, fadeToB, removeScene, renameScene, selectScene, setBusA, setBusB, setMixSettings, setSceneRenderPaused, updateSceneCode],
  );

  useEffect(() => {
    const mood = analyzeAudioMood(audio);
    const now = performance.now();
    if (now - autoLastSnapshotAtRef.current >= 900) {
      autoLastSnapshotAtRef.current = now;
      autoAudioHistoryRef.current = trimAudioHistory([
        ...autoAudioHistoryRef.current,
        {
          at: now,
          bpm: audio.bpm,
          beat: audio.beat,
          beatCount: audio.beatCount,
          energy: mood.energy,
          bass: mood.bass,
          mid: mood.mid,
          treble: mood.treble,
          tags: [
            ...audio.musicTags.map((tag) => ({ label: tag.label, confidence: tag.confidence })),
            ...(audio.moodPredictions ?? []).map((mood) => ({
              label: `Mood:${mood.label}`,
              confidence: mood.confidence,
            })),
          ],
        },
      ], 90);
    }
    if (now - autoLastStatusAtRef.current >= 250) {
      autoLastStatusAtRef.current = now;
      setAutoStatus((s) => ({
        ...s,
        mood,
        nextTrigger: autoVJ.enabled
          ? aiConfig.apiKey
            ? audio.enabled
              ? s.nextTrigger
              : "Start audio to drive automation"
            : "API key required"
          : "Disabled",
      }));
    }
  }, [aiConfig.apiKey, audio, autoVJ.enabled]);

  useEffect(() => {
    if (!autoVJ.enabled || !aiConfig.apiKey || !audio.enabled) return;

    const mood = analyzeAudioMood(audio);
    const intervalBeats = Math.max(1, autoVJ.intervalBars * 4);
    const hasBeatClock = audio.beatCount > 0 && audio.bpm > 0;
    const now = performance.now();

    if (hasBeatClock) {
      if (autoLastBeatRef.current === 0) {
        autoLastBeatRef.current = audio.beatCount;
      }
      const elapsedBeats = audio.beatCount - autoLastBeatRef.current;
      const elapsedMs = autoLastDecisionAtRef.current > 0 ? now - autoLastDecisionAtRef.current : Number.POSITIVE_INFINITY;
      setAutoStatus((s) => ({
        ...s,
        mood,
        nextTrigger: `${Math.max(0, intervalBeats - elapsedBeats)} beats / ${Math.max(0, Math.ceil((autoVJ.decisionSeconds * 1000 - elapsedMs) / 1000))}s`,
      }));
      if (!autoPrimedRef.current && audio.beat) {
        autoPrimedRef.current = true;
        autoLastBeatRef.current = audio.beatCount;
        autoLastDecisionAtRef.current = now;
        void runAutoVJCycle("initial mood lock", mood);
        return;
      }
      if (audio.beat && elapsedBeats >= intervalBeats && elapsedMs >= autoVJ.decisionSeconds * 1000) {
        autoLastBeatRef.current = audio.beatCount;
        autoLastDecisionAtRef.current = now;
        void runAutoVJCycle(`${autoVJ.intervalBars} bar refresh`, mood);
      }
      return;
    }

    const wallInterval = Math.max(5_000, autoVJ.decisionSeconds * 1000);
    if (autoLastWallTriggerRef.current === 0) autoLastWallTriggerRef.current = now;
    const remainingMs = Math.max(0, wallInterval - (now - autoLastWallTriggerRef.current));
    setAutoStatus((s) => ({
      ...s,
      mood,
      nextTrigger: `${Math.ceil(remainingMs / 1000)}s`,
    }));
    if (!autoPrimedRef.current || remainingMs <= 0) {
      const reason = autoPrimedRef.current ? "timed refresh" : "initial mood lock";
      autoPrimedRef.current = true;
      autoLastWallTriggerRef.current = now;
      autoLastDecisionAtRef.current = now;
      void runAutoVJCycle(reason, mood);
    }
  }, [aiConfig.apiKey, audio, autoVJ.enabled, autoVJ.intervalBars, autoVJ.decisionSeconds, runAutoVJCycle]);

  useEffect(() => {
    if (!autoVJ.enabled) {
      autoLastBeatRef.current = 0;
      autoLastWallTriggerRef.current = 0;
      autoLastDecisionAtRef.current = 0;
      autoPrimedRef.current = false;
    }
  }, [autoVJ.enabled]);

  useEffect(() => {
    enforceRenderBudget(scenes, busA, busB, selectedSceneId, new Set(), setSceneRenderPaused);
  }, [busA, busB, scenes, selectedSceneId, setSceneRenderPaused]);

  useEffect(() => {
    let closing = false;
    const currentWindow = getCurrentWindow();
    const unlisten = currentWindow.onCloseRequested(async (event) => {
      if (closing) return;
      event.preventDefault();
      closing = true;
      try {
        await closeOutputWindows();
      } finally {
        await currentWindow.destroy();
      }
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    const currentClock = () => ({
      clockTimeSeconds: (performance.now() - clockStartedAtRef.current) / 1000,
      clockSentAtMs: Date.now(),
    });

    const buildStatePayload = () => {
      const state = useVJStore.getState();
      return {
        scenes: state.scenes,
        busA: state.busA,
        busB: state.busB,
        crossfade: state.crossfade,
        mix: state.mix,
        isPlaying: state.isPlaying,
        selectedSceneId: state.selectedSceneId,
        audio: state.audio,
        ...currentClock(),
      };
    };

    const publishState = () => {
      emitVJState(buildStatePayload());
    };

    const unsub = useVJStore.subscribe((state, previous) => {
      if (
        state.audio !== previous.audio &&
        state.scenes === previous.scenes &&
        state.busA === previous.busA &&
        state.busB === previous.busB &&
        state.crossfade === previous.crossfade &&
        state.mix === previous.mix &&
        state.isPlaying === previous.isPlaying &&
        state.selectedSceneId === previous.selectedSceneId
      ) {
        emitVJAudio(state.audio);
        return;
      }
      if (
        state.scenes === previous.scenes &&
        state.audio === previous.audio &&
        state.busA === previous.busA &&
        state.busB === previous.busB &&
        state.selectedSceneId === previous.selectedSceneId &&
        (
          state.crossfade !== previous.crossfade ||
          state.mix !== previous.mix ||
          state.isPlaying !== previous.isPlaying
        )
      ) {
        emitVJRuntime({
          crossfade: state.crossfade,
          mix: state.mix,
          isPlaying: state.isPlaying,
          ...currentClock(),
        });
        return;
      }
      publishState();
    });
    const unlistenRequest = listenVJStateRequest(publishState);
    publishState();

    return () => {
      unsub();
      unlistenRequest.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    const publishLedState = () => {
      const led = useLedStore.getState();
      emitLedState({
        source: "control",
        config: led.config,
        calibrationPoints: led.calibrationPoints,
        layoutInfo: led.layoutInfo,
        mappingHandles: led.mappingHandles,
        rawCameraPoints: led.rawCameraPoints,
        connected: led.connected,
      });
    };

    const unsub = useLedStore.subscribe(publishLedState);
    const unlistenRequest = listenLedStateRequest(publishLedState);
    publishLedState();

    return () => {
      unsub();
      unlistenRequest.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    const unlisten = listenLedState((state) => {
      if (state.source === "control") return;
      const led = useLedStore.getState();
      led.loadSyncedState(state.config, state.calibrationPoints, state.layoutInfo, state.connected, state.mappingHandles, state.rawCameraPoints);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  const assignScene = useCallback(
    (sceneId: string, bus: BusLabel) => {
      const scene = useVJStore.getState().scenes.find((item) => item.id === sceneId);
      if (scene?.renderPaused) return;
      if (bus === "A") setBusA(sceneId);
      else setBusB(sceneId);
    },
    [setBusA, setBusB],
  );

  const toggleOutputDecorations = useCallback(async () => {
    try {
      const decorated = await toggleTauriOutputDecorations();
      if (decorated !== null) setOutputDecorated(decorated);
    } catch (e) {
      console.error("Failed to toggle decorations:", e);
    }
  }, []);

  const pickVideoFile = useCallback(async () => {
    if (!selectedSceneId) return;
    try {
      const path = await chooseVideoPath();
      if (!path) return;
      updateSceneCode(selectedSceneId, await resolveVideoUrl(path));
    } catch (e) {
      console.error("Video selection failed:", e);
    }
  }, [selectedSceneId, updateSceneCode]);

  return (
    <div className="control-shell">
      <TopBar isPlaying={isPlaying} audio={audio} autoStatus={autoStatus} latestAutoLog={autoLog[0]} webglDiagnostics={webglDiagnostics} nativeGpuDiagnostics={nativeGpuDiagnostics} onTogglePlay={() => setPlaying(!isPlaying)} />
      <div className={`app-grid ${workspace === "led" ? "is-led" : ""}`}>
        <SideNav workspace={workspace} onChange={setWorkspace} />
        {workspace !== "led" && (
          <ContextPanel
            workspace={workspace}
            scenes={scenes}
            selectedScene={selectedScene}
            selectedSceneId={selectedSceneId}
            busA={busA}
            busB={busB}
            selectedCanvasRef={contextSelectedCanvasRef}
            onAddScene={addScene}
            onAssignScene={assignScene}
            onDeleteScene={removeScene}
            onRenderPauseScene={setSceneRenderPaused}
            onSelectScene={selectScene}
            onScenePreviewRef={(sceneId, canvas) => {
              if (canvas) scenePreviewCanvasesRef.current.set(sceneId, canvas);
              else scenePreviewCanvasesRef.current.delete(sceneId);
            }}
          />
        )}
        <MainWorkspace
          workspace={workspace}
          scenes={scenes}
          selectedScene={selectedScene}
          busAScene={busAScene}
          busBScene={busBScene}
          crossfade={crossfade}
          mix={mix}
          isPlaying={isPlaying}
          audio={audio}
          outputDecorated={outputDecorated}
          aiConfig={aiConfig}
          aiGenerating={aiGenerating}
          aiError={aiError}
          autoVJ={autoVJ}
          autoStatus={autoStatus}
          autoLog={autoLog}
          outputPreviewRef={outputPreviewRef}
          busACanvasRef={busACanvasRef}
          busBCanvasRef={busBCanvasRef}
          selectedCanvasRef={selectedCanvasRef}
          codeSelectedCanvasRef={codeSelectedCanvasRef}
          onCutA={cutToA}
          onCutB={cutToB}
          onFadeA={fadeToA}
          onFadeB={fadeToB}
          onCrossfade={setCrossfade}
          onMixChange={setMixSettings}
          onSave={handleSave}
          onLoad={handleLoad}
          onToggleOutputDecorations={toggleOutputDecorations}
          onToggleAudio={setAudioEnabled}
          onAudioDevice={setAudioDevice}
          onAiGenerate={handleAiGenerate}
          onAiEdit={selectedScene ? handleAiEdit : undefined}
          onAiConfigChange={aiSetConfig}
          onAutoVJChange={updateAutoVJ}
          onCodeChange={(code) => selectedScene && updateSceneCode(selectedScene.id, code)}
          onSceneKeyChange={(key) => selectedScene && setSceneKey(selectedScene.id, key)}
          onPickVideo={pickVideoFile}
          sendCommand={sendCommand}
          getVideoInfo={getVideoInfo}
          onVideoSyncChange={(sync) => selectedScene && setVideoSync(selectedScene.id, sync)}
        />
      </div>
      <div className="global-transport">
        <TransportPanel
          crossfade={crossfade}
          mix={mix}
          onCutA={cutToA}
          onCutB={cutToB}
          onFadeA={fadeToA}
          onFadeB={fadeToB}
          onCrossfade={setCrossfade}
          onMixChange={setMixSettings}
        />
      </div>
    </div>
  );
}

function TopBar({ isPlaying, audio, autoStatus, latestAutoLog, webglDiagnostics, nativeGpuDiagnostics, onTogglePlay }: { isPlaying: boolean; audio: AudioAnalysis; autoStatus: AutoVJStatus; latestAutoLog?: AutoVJLogEntry; webglDiagnostics: WebGLDiagnostics | null; nativeGpuDiagnostics: NativeGpuDiagnostics | null; onTogglePlay: () => void }) {
  const nativeLabel = nativeGpuDiagnostics?.renderer && nativeGpuDiagnostics.renderer !== "unknown"
    ? nativeGpuDiagnostics.renderer
    : null;
  const gpuLabel = webglDiagnostics
    ? webglDiagnostics.supported
      ? `${webglDiagnostics.suspicious ? "WEBGL?" : webglDiagnostics.accelerated ? "GPU" : "SW"} ${nativeLabel ?? webglDiagnostics.renderer}`
      : "NO WEBGL"
    : "GPU CHECK";
  const gpuHealthy = !!webglDiagnostics?.supported && !webglDiagnostics.suspicious && webglDiagnostics.accelerated;
  const gpuTitle = [
    nativeGpuDiagnostics ? `Native: ${nativeGpuDiagnostics.vendor} / ${nativeGpuDiagnostics.renderer} (${nativeGpuDiagnostics.source})` : null,
    webglDiagnostics ? `WebGL: ${webglDiagnostics.vendor} / ${webglDiagnostics.renderer}` : null,
  ].filter(Boolean).join("\n");
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand__mark">VJLED</span>
        <span className="brand__sub">CONTROL</span>
      </div>
      <div className="topbar__status">
        <span className="status-chip"><span className={`status-dot ${isPlaying ? "is-live" : ""}`} />{isPlaying ? "LIVE" : "PAUSED"}</span>
        <span className="status-chip">{audio.bpm ? `${audio.bpm.toFixed(1)} BPM` : "NO BPM"}</span>
        <span className="status-chip">{audio.musicTags.length ? audio.musicTags.slice(0, 3).map((tag) => tag.label.toUpperCase()).join(" / ") : "NO TAGS"}</span>
        <span className="status-chip status-chip--auto">{latestAutoLog ? `${latestAutoLog.kind}: ${latestAutoLog.message}` : autoStatus.lastAction}</span>
        <span className={`status-chip ${gpuHealthy ? "status-chip--gpu" : "status-chip--warn"}`} title={gpuTitle || undefined}>{gpuLabel}</span>
        <span className="status-chip">{audio.permission.toUpperCase()}</span>
      </div>
      <button className={`button ${isPlaying ? "is-primary" : ""}`} onClick={onTogglePlay}>{isPlaying ? "Pause" : "Go Live"}</button>
    </header>
  );
}

function SideNav({ workspace, onChange }: { workspace: Workspace; onChange: (workspace: Workspace) => void }) {
  const items: { id: Workspace; label: string; icon: string }[] = [
    { id: "perform", label: "Run", icon: "P" },
    { id: "project", label: "Project", icon: "J" },
    { id: "output", label: "Output", icon: "O" },
    { id: "audio", label: "Audio", icon: "A" },
    { id: "ai", label: "AI/Code", icon: "C" },
    { id: "led", label: "LED", icon: "L" },
  ];

  return (
    <nav className="side-nav" aria-label="Workspace">
      <div className="unit-badge">01</div>
      {items.map((item) => (
        <button key={item.id} className={`side-tab ${workspace === item.id ? "is-active" : ""}`} onClick={() => onChange(item.id)}>
          <span className="side-tab__icon">{item.icon}</span>
          <span>{item.label}</span>
        </button>
      ))}
    </nav>
  );
}

function ContextPanel(props: {
  workspace: Workspace;
  scenes: Scene[];
  selectedScene: Scene | null;
  selectedSceneId: string | null;
  busA: string | null;
  busB: string | null;
  selectedCanvasRef: React.RefObject<HTMLCanvasElement | null>;
  onAddScene: (type: SceneType) => void;
  onAssignScene: (sceneId: string, bus: BusLabel) => void;
  onDeleteScene: (id: string) => void;
  onRenderPauseScene: (id: string, paused: boolean) => void;
  onScenePreviewRef: (sceneId: string, canvas: HTMLCanvasElement | null) => void;
  onSelectScene: (id: string | null) => void;
}) {
  return (
    <aside className="context-panel">
      <ModuleHeader title="Scenes" meta={`${props.scenes.length} SRC`} />
      <div className="context-preview">
        <PreviewFrame title="Selected" meta={props.selectedScene?.name ?? "none"} tone={props.selectedScene ? typeColors[props.selectedScene.type] : "var(--dim)"}>
          <canvas ref={props.selectedCanvasRef} width={480} height={270} />
        </PreviewFrame>
      </div>
      <SceneLibrary {...props} />
    </aside>
  );
}

function SceneLibrary({ scenes, selectedSceneId, busA, busB, onAddScene, onAssignScene, onDeleteScene, onRenderPauseScene, onScenePreviewRef, onSelectScene }: Omit<Parameters<typeof ContextPanel>[0], "workspace" | "selectedScene" | "selectedCanvasRef">) {
  return (
    <>
      <div className="scene-list">
        {scenes.map((scene) => (
          <SceneCard
            key={scene.id}
            scene={scene}
            selected={selectedSceneId === scene.id}
            onA={busA === scene.id}
            onB={busB === scene.id}
            onSelect={() => onSelectScene(scene.id)}
            onDelete={() => onDeleteScene(scene.id)}
            onRenderPause={() => onRenderPauseScene(scene.id, !scene.renderPaused)}
            onAssign={(bus) => onAssignScene(scene.id, bus)}
            onPreviewRef={(canvas) => onScenePreviewRef(scene.id, canvas)}
          />
        ))}
        {scenes.length === 0 && <EmptyState>Select a source type below.</EmptyState>}
      </div>
      <div className="source-buttons">
        {(Object.keys(typeColors) as SceneType[]).map((type) => (
          <button key={type} className="button is-active" style={{ "--active": typeColors[type] } as React.CSSProperties} onClick={() => onAddScene(type)}>
            + {sceneTypeLabel(type)}
          </button>
        ))}
      </div>
    </>
  );
}

function MainWorkspace(props: {
  workspace: Workspace;
  scenes: Scene[];
  selectedScene: Scene | null;
  busAScene: Scene | undefined;
  busBScene: Scene | undefined;
  crossfade: number;
  mix: MixSettings;
  isPlaying: boolean;
  audio: AudioAnalysis;
  outputDecorated: boolean;
  aiConfig: { baseUrl: string; apiKey: string; model: string };
  aiGenerating: boolean;
  aiError: string | null;
  autoVJ: AutoVJSettings;
  autoStatus: AutoVJStatus;
  autoLog: AutoVJLogEntry[];
  outputPreviewRef: React.RefObject<HTMLDivElement | null>;
  busACanvasRef: React.RefObject<HTMLCanvasElement | null>;
  busBCanvasRef: React.RefObject<HTMLCanvasElement | null>;
  selectedCanvasRef: React.RefObject<HTMLCanvasElement | null>;
  codeSelectedCanvasRef: React.RefObject<HTMLCanvasElement | null>;
  onCutA: () => void;
  onCutB: () => void;
  onFadeA: () => void;
  onFadeB: () => void;
  onCrossfade: (value: number) => void;
  onMixChange: (mix: Partial<MixSettings>) => void;
  onSave: () => void;
  onLoad: () => void;
  onToggleOutputDecorations: () => void;
  onToggleAudio: (enabled: boolean) => void;
  onAudioDevice: (deviceId: string, label?: string) => void;
  onAiGenerate: (type: SceneType, prompt: string) => void;
  onAiEdit?: (prompt: string) => void;
  onAiConfigChange: (config: Partial<{ baseUrl: string; apiKey: string; model: string }>) => void;
  onAutoVJChange: (settings: Partial<AutoVJSettings>) => void;
  onCodeChange: (code: string) => void;
  onSceneKeyChange: (key: SceneKeySettings) => void;
  onPickVideo: () => void;
  sendCommand: (id: string, action: string, value: unknown) => void;
  getVideoInfo: (id: string) => { currentTime: number; duration: number; playing: boolean; loop: boolean; loopStart: number; loopEnd: number; bpmLoop: boolean; beatsPerLoop: number } | null;
  onVideoSyncChange: (sync: VideoSync) => void;
}) {
  if (props.workspace === "ai") {
    return <AiCodeWorkspace {...props} />;
  }

  return (
    <main className={`main-workspace ${props.workspace === "led" ? "is-led" : ""}`}>
      <PerformanceStage {...props} />
      <FeaturePanel {...props} />
    </main>
  );
}

function PerformanceStage(props: {
  workspace: Workspace;
  selectedScene: Scene | null;
  busAScene: Scene | undefined;
  busBScene: Scene | undefined;
  crossfade: number;
  mix: MixSettings;
  outputPreviewRef: React.RefObject<HTMLDivElement | null>;
  busACanvasRef: React.RefObject<HTMLCanvasElement | null>;
  busBCanvasRef: React.RefObject<HTMLCanvasElement | null>;
  selectedCanvasRef: React.RefObject<HTMLCanvasElement | null>;
  onCutA: () => void;
  onCutB: () => void;
  onFadeA: () => void;
  onFadeB: () => void;
  onCrossfade: (value: number) => void;
  onMixChange: (mix: Partial<MixSettings>) => void;
}) {
  const ledWorkspace = props.workspace === "led";
  return (
    <section className={`stage ${ledWorkspace ? "is-led" : ""}`}>
      <PreviewFrame title="Program Output" meta={outputMeta(props.selectedScene, props.busAScene, props.busBScene, props.crossfade, props.mix)} tone="var(--cyan)" program>
        <div ref={props.outputPreviewRef} className="render-mount" />
      </PreviewFrame>
      {!ledWorkspace && (
        <>
          <div className="bus-row">
            <PreviewFrame title="Bus A" meta={props.busAScene?.name ?? "empty"} tone="var(--cyan)">
              <canvas ref={props.busACanvasRef} width={480} height={270} />
            </PreviewFrame>
            <PreviewFrame title="Bus B" meta={props.busBScene?.name ?? "empty"} tone="var(--rose)">
              <canvas ref={props.busBCanvasRef} width={480} height={270} />
            </PreviewFrame>
            <PreviewFrame title="Selected" meta={props.selectedScene?.name ?? "none"} tone={props.selectedScene ? typeColors[props.selectedScene.type] : "var(--dim)"}>
              <canvas ref={props.selectedCanvasRef} width={480} height={270} />
            </PreviewFrame>
          </div>
          <TransportPanel crossfade={props.crossfade} mix={props.mix} onCutA={props.onCutA} onCutB={props.onCutB} onFadeA={props.onFadeA} onFadeB={props.onFadeB} onCrossfade={props.onCrossfade} onMixChange={props.onMixChange} />
        </>
      )}
    </section>
  );
}

function FeaturePanel(props: Parameters<typeof MainWorkspace>[0]) {
  if (props.workspace === "project") {
    return <ProjectPanel onSave={props.onSave} onLoad={props.onLoad} scenes={props.scenes} selectedScene={props.selectedScene} />;
  }
  if (props.workspace === "output") {
    return <OutputPanel {...props} />;
  }
  if (props.workspace === "audio") {
    return <AudioPanel audio={props.audio} onToggle={props.onToggleAudio} onDevice={props.onAudioDevice} />;
  }
  if (props.workspace === "led") {
    return <LedWorkspace />;
  }
  return <PerformanceSummary selectedScene={props.selectedScene} busAScene={props.busAScene} busBScene={props.busBScene} crossfade={props.crossfade} mix={props.mix} onMixChange={props.onMixChange} />;
}

function TransportPanel({ crossfade, mix, onCutA, onCutB, onFadeA, onFadeB, onCrossfade, onMixChange }: {
  crossfade: number;
  mix: MixSettings;
  onCutA: () => void;
  onCutB: () => void;
  onFadeA: () => void;
  onFadeB: () => void;
  onCrossfade: (value: number) => void;
  onMixChange: (mix: Partial<MixSettings>) => void;
}) {
  return (
    <div className="transport">
      <div className="transport__group transport__cut-pair">
        <button className="button" onClick={onCutA}>Cut A</button>
        <button className="button" onClick={onCutB}>Cut B</button>
      </div>
      <div className="xfade">
        <div className="xfade__labels">
          <span>A</span>
          <span>{mixLabels[mix.mode]} {(crossfade * 100).toFixed(0)}%</span>
          <span>B</span>
        </div>
        <input className="range xfade__range" type="range" min={0} max={1} step={0.005} value={crossfade} onChange={(e) => onCrossfade(parseFloat(e.target.value))} />
      </div>
      <div className="transport__group transport__fade-pair">
        <button className="button" onClick={() => onFadeA()}>To A</button>
        <button className="button" onClick={() => onFadeB()}>To B</button>
      </div>
      <div className="field transport__mode">
        <label>Mix Mode</label>
        <select value={mix.mode} onChange={(e) => onMixChange({ mode: e.target.value as MixMode })}>
          <optgroup label="Blend">
            {blendModes.map((mode) => <option key={mode} value={mode}>{mixLabels[mode]}</option>)}
          </optgroup>
          <optgroup label="Transition">
            {transitionModes.map((mode) => <option key={mode} value={mode}>{mixLabels[mode]}</option>)}
          </optgroup>
        </select>
      </div>
      <div className="transport__tune">
        <MiniSlider label="Intensity" value={mix.intensity} min={0} max={1} step={0.01} onChange={(value) => onMixChange({ intensity: value })} />
        <MiniSlider label="Feather" value={mix.feather} min={0.001} max={0.5} step={0.005} onChange={(value) => onMixChange({ feather: value })} />
      </div>
    </div>
  );
}

function AiCodeWorkspace(props: Parameters<typeof MainWorkspace>[0]) {
  return (
    <main className="ai-code-workspace">
      <section className="ai-panel">
        <AiPanel
          generating={props.aiGenerating}
          error={props.aiError}
          onGenerate={props.onAiGenerate}
          onEdit={props.onAiEdit}
          config={props.aiConfig}
          onConfigChange={props.onAiConfigChange}
          selectedScene={props.selectedScene}
          audio={props.audio}
          autoVJ={props.autoVJ}
          autoStatus={props.autoStatus}
          autoLog={props.autoLog}
          onAutoVJChange={props.onAutoVJChange}
        />
      </section>
      <section className="code-panel">
        <div className="panel-header">
          <SectionTitle>{props.selectedScene ? `Code: ${props.selectedScene.name}` : "Code"}</SectionTitle>
          {props.selectedScene && <span className="scene-card__badge" style={{ color: typeColors[props.selectedScene.type] }}>{props.selectedScene.type}</span>}
        </div>
        <div className="code-preview">
          <PreviewFrame title="Selected Preview" meta={props.selectedScene?.name ?? "none"} tone={props.selectedScene ? typeColors[props.selectedScene.type] : "var(--dim)"}>
            <canvas ref={props.codeSelectedCanvasRef} width={480} height={270} />
          </PreviewFrame>
        </div>
        <div className="code-editor">
          {props.selectedScene ? (
            props.selectedScene.type === "video" ? (
              <VideoEditor scene={props.selectedScene} audio={props.audio} onPick={props.onPickVideo} sendCommand={props.sendCommand} getVideoInfo={props.getVideoInfo} onSyncChange={props.onVideoSyncChange} onKeyChange={props.onSceneKeyChange} />
            ) : (
              <div className="code-editor__stack">
                <SceneKeyControls scene={props.selectedScene} onChange={props.onSceneKeyChange} compact />
                <Editor
                  height="100%"
                  language={props.selectedScene.type === "glsl" ? "cpp" : "javascript"}
                  theme="vs-dark"
                  value={props.selectedScene.code}
                  onChange={(value) => value !== undefined && props.onCodeChange(value)}
                  options={{
                    minimap: { enabled: false },
                    fontSize: 13,
                    lineNumbers: "on",
                    scrollBeyondLastLine: false,
                    wordWrap: "on",
                    tabSize: 2,
                    automaticLayout: true,
                    padding: { top: 10 },
                  }}
                />
              </div>
            )
          ) : (
            <EmptyState>Select a scene to edit code.</EmptyState>
          )}
        </div>
      </section>
    </main>
  );
}

function ModuleHeader({ title, meta }: { title: string; meta?: string }) {
  return (
    <div className="module-header">
      <span className="module-title">{title}</span>
      {meta && <span className="module-meta">{meta}</span>}
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <div className="module-title">{children}</div>;
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return <div className="empty-state"><p className="help">{children}</p></div>;
}

function SceneCard({ scene, selected, onA, onB, onSelect, onDelete, onRenderPause, onAssign, onPreviewRef }: {
  scene: Scene;
  selected: boolean;
  onA: boolean;
  onB: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onRenderPause: () => void;
  onAssign: (bus: BusLabel) => void;
  onPreviewRef: (canvas: HTMLCanvasElement | null) => void;
}) {
  return (
    <div className={`scene-card ${selected ? "is-selected" : ""} ${scene.renderPaused ? "is-render-paused" : ""}`} style={{ "--type": typeColors[scene.type] } as React.CSSProperties} onClick={onSelect} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onSelect(); }}>
      <div className="scene-card__preview">
        <canvas ref={onPreviewRef} width={192} height={108} />
      </div>
      <div className="scene-card__top">
        <span className="scene-card__led" />
        <span className="scene-card__name">{scene.name}</span>
        <span className="scene-card__badge">{scene.renderPaused ? "paused" : scene.type}</span>
      </div>
      <div className="scene-card__actions">
        <button className={`button ${onA ? "is-active" : ""}`} disabled={scene.renderPaused} style={{ "--active": "var(--cyan)" } as React.CSSProperties} onClick={(e) => { e.stopPropagation(); onAssign("A"); }}>A</button>
        <button className={`button ${onB ? "is-active" : ""}`} disabled={scene.renderPaused} style={{ "--active": "var(--rose)" } as React.CSSProperties} onClick={(e) => { e.stopPropagation(); onAssign("B"); }}>B</button>
        <button className={`button ${scene.renderPaused ? "is-primary" : ""}`} title={scene.renderPaused ? "Resume rendering" : "Pause rendering without deleting"} onClick={(e) => { e.stopPropagation(); onRenderPause(); }}>{scene.renderPaused ? "Run" : "Stop"}</button>
        <button className="button is-danger" title="Delete scene" onClick={(e) => { e.stopPropagation(); onDelete(); }}>x</button>
      </div>
    </div>
  );
}

function PreviewFrame({ title, meta, tone, program, children }: { title: string; meta: string; tone: string; program?: boolean; children: React.ReactNode }) {
  return (
    <div className={`preview-frame ${program ? "is-program" : ""}`} style={{ "--tone": tone } as React.CSSProperties}>
      <div className="preview-frame__head">
        <span className="preview-frame__tone" />
        <span className="preview-frame__title">{title}</span>
        <span className="preview-frame__meta">{meta}</span>
      </div>
      <div className="preview-frame__body">{children}</div>
    </div>
  );
}

function PerformanceSummary({ selectedScene, busAScene, busBScene, crossfade, mix, onMixChange }: { selectedScene: Scene | null; busAScene: Scene | undefined; busBScene: Scene | undefined; crossfade: number; mix: MixSettings; onMixChange: (mix: Partial<MixSettings>) => void }) {
  return (
    <aside className="feature-panel">
      <SectionTitle>Performance</SectionTitle>
      <InfoGrid rows={[
        ["Bus A", busAScene?.name ?? "Empty"],
        ["Bus B", busBScene?.name ?? "Empty"],
        ["Selected", selectedScene?.name ?? "None"],
        ["Mix", `${mixLabels[mix.mode]} ${(crossfade * 100).toFixed(0)}%`],
      ]} />
      <ModePad mix={mix} onChange={onMixChange} />
    </aside>
  );
}

function ProjectPanel({ onSave, onLoad, scenes, selectedScene }: { onSave: () => void; onLoad: () => void; scenes: Scene[]; selectedScene: Scene | null }) {
  return (
    <aside className="feature-panel">
      <SectionTitle>Project</SectionTitle>
      <div className="action-row">
        <button className="button is-primary" onClick={onSave}>Save</button>
        <button className="button" onClick={onLoad}>Load</button>
      </div>
      <InfoGrid rows={[
        ["Scenes", String(scenes.length)],
        ["Selected", selectedScene?.name ?? "None"],
        ["Type", selectedScene?.type ?? "-"],
      ]} />
    </aside>
  );
}

function OutputPanel({ busAScene, busBScene, crossfade, mix, isPlaying, outputDecorated, onToggleOutputDecorations }: Parameters<typeof MainWorkspace>[0]) {
  const [monitors, setMonitors] = useState<OutputMonitor[]>([]);
  const [selectedMonitorIds, setSelectedMonitorIds] = useState<string[]>([]);
  const [monitorError, setMonitorError] = useState<string | null>(null);
  const [monitorBusy, setMonitorBusy] = useState(false);
  const selectedMonitors = monitors.filter((monitor) => selectedMonitorIds.includes(monitor.id));

  const refreshMonitors = useCallback(async () => {
    setMonitorBusy(true);
    setMonitorError(null);
    try {
      const next = await listOutputMonitors();
      setMonitors(next);
      setSelectedMonitorIds((current) => {
        const availableIds = new Set(next.map((monitor) => monitor.id));
        const preserved = current.filter((id) => availableIds.has(id));
        return preserved.length ? preserved : next.slice(0, 1).map((monitor) => monitor.id);
      });
    } catch (e) {
      console.error("Failed to list monitors:", e);
      setMonitorError(e instanceof Error ? e.message : "Failed to list monitors.");
    } finally {
      setMonitorBusy(false);
    }
  }, []);

  const setMonitorSelected = useCallback((monitorId: string, selected: boolean) => {
    setSelectedMonitorIds((current) => {
      if (selected) return current.includes(monitorId) ? current : [...current, monitorId];
      return current.filter((id) => id !== monitorId);
    });
  }, []);

  const assignOutputs = useCallback(async (fitToMonitor: boolean) => {
    if (selectedMonitors.length === 0) return;
    setMonitorBusy(true);
    setMonitorError(null);
    try {
      await assignOutputsToMonitors(selectedMonitors, fitToMonitor, monitors);
    } catch (e) {
      console.error("Failed to move output window:", e);
      setMonitorError(e instanceof Error ? e.message : "Failed to move output window.");
    } finally {
      setMonitorBusy(false);
    }
  }, [monitors, selectedMonitors]);

  useEffect(() => {
    refreshMonitors();
  }, [refreshMonitors]);

  return (
    <aside className="feature-panel">
      <SectionTitle>Output</SectionTitle>
      <InfoGrid rows={[
        ["Status", isPlaying ? "Playing" : "Paused"],
        ["Bus A", busAScene?.name ?? "Empty"],
        ["Bus B", busBScene?.name ?? "Empty"],
        ["Mix", `${mixLabels[mix.mode]} ${(crossfade * 100).toFixed(0)}%`],
        ["Title bar", outputDecorated ? "Visible" : "Hidden"],
      ]} />
      <button className="button" onClick={onToggleOutputDecorations}>{outputDecorated ? "Hide Output Title Bar" : "Show Output Title Bar"}</button>
      <div className="subpanel">
        <ModuleHeader title="Display Targets" meta={`${selectedMonitors.length}/${monitors.length} selected`} />
        <div className="output-monitor-list">
          {monitors.length === 0 ? (
            <p className="help">No monitors detected</p>
          ) : (
            monitors.map((monitor) => (
              <label key={monitor.id} className="output-monitor-option">
                <input
                  type="checkbox"
                  checked={selectedMonitorIds.includes(monitor.id)}
                  disabled={monitorBusy}
                  onChange={(e) => setMonitorSelected(monitor.id, e.target.checked)}
                />
                <span>
                  <strong>{monitor.label}</strong>
                  <small>{monitor.size.width} x {monitor.size.height} / scale {monitor.scaleFactor.toFixed(2)}x</small>
                </span>
              </label>
            ))
          )}
        </div>
        <InfoGrid rows={[
          ["Windows", selectedMonitors.length > 0 ? String(selectedMonitors.length) : "None"],
          ["Mode", "Same program output on each display"],
        ]} />
        <div className="action-row output-monitor-actions">
          <button className="button" onClick={refreshMonitors} disabled={monitorBusy}>Refresh</button>
          <button className="button" onClick={() => setSelectedMonitorIds(monitors.map((monitor) => monitor.id))} disabled={monitorBusy || monitors.length === 0}>All</button>
          <button className="button is-primary" onClick={() => assignOutputs(true)} disabled={monitorBusy || selectedMonitors.length === 0}>Fit Selected</button>
        </div>
        <button className="button" onClick={() => assignOutputs(false)} disabled={monitorBusy || selectedMonitors.length === 0}>Move Selected Without Resize</button>
        {monitorError && <p className="help is-error">{monitorError}</p>}
      </div>
    </aside>
  );
}

function AudioPanel({ audio, onToggle, onDevice }: { audio: AudioAnalysis; onToggle: (enabled: boolean) => void; onDevice: (deviceId: string, label?: string) => void }) {
  const [devices, setDevices] = useState<RustAudioDevice[]>([]);
  const moodPredictions = audio.moodPredictions ?? [];

  useEffect(() => {
    listAudioDevices().then(setDevices).catch(() => {});
  }, []);

  return (
    <aside className="feature-panel">
      <SectionTitle>Audio</SectionTitle>
      <button className={`button ${audio.enabled ? "is-primary" : ""}`} onClick={() => onToggle(!audio.enabled)}>
        {audio.enabled ? "Stop Audio" : "Start Audio"}
      </button>
      <div className="field">
        <label>Audio Device</label>
        <select
          value={audio.deviceId}
          onChange={(e) => {
            const device = devices.find((d) => d.id === e.target.value);
            onDevice(e.target.value, device?.name);
          }}
        >
          <option value="">Auto</option>
          {devices.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name} {d.is_loopback ? "[Loopback]" : d.is_input ? "[In]" : d.is_output ? "[Out]" : ""}
            </option>
          ))}
        </select>
      </div>
      <InfoGrid rows={[
        ["Status", audio.permission],
        ["Device", audio.deviceLabel || audio.deviceId || "Default"],
        ["BPM", audio.bpm ? audio.bpm.toFixed(1) : "-"],
        ["Beat", audio.beat ? "Yes" : "No"],
        ["Tags", audio.musicTags.length ? audio.musicTags.map((tag) => `${tag.label} ${(tag.confidence * 100).toFixed(0)}%`).join(", ") : "No ONNX result"],
        ["Mood Scores", moodPredictions.length ? moodPredictions.map((mood) => `${mood.label} ${(mood.confidence * 100).toFixed(0)}%`).join(", ") : "No mood result"],
      ]} />
      <MoodScoreBars moods={moodPredictions} />
      <div className="vu">
        {audio.fft.slice(0, 16).map((v, i) => (
          <div key={i} className="vu__bar" style={{ height: `${Math.max(3, v * 48)}px`, background: i < 5 ? "var(--green)" : i < 12 ? "var(--cyan)" : "var(--rose)" }} />
        ))}
      </div>
    </aside>
  );
}

function AiPanel({ generating, error, onGenerate, onEdit, config, onConfigChange, selectedScene, audio, autoVJ, autoStatus, autoLog, onAutoVJChange }: {
  generating: boolean;
  error: string | null;
  onGenerate: (type: SceneType, prompt: string) => void;
  onEdit?: (prompt: string) => void;
  config: { baseUrl: string; apiKey: string; model: string };
  onConfigChange: (c: Partial<{ baseUrl: string; apiKey: string; model: string }>) => void;
  selectedScene: Scene | null;
  audio: AudioAnalysis;
  autoVJ: AutoVJSettings;
  autoStatus: AutoVJStatus;
  autoLog: AutoVJLogEntry[];
  onAutoVJChange: (settings: Partial<AutoVJSettings>) => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [selectedType, setSelectedType] = useState<SceneType>("glsl");
  const [showSettings, setShowSettings] = useState(false);
  const disabled = generating || !prompt.trim() || !config.apiKey;

  return (
    <div className="panel-body">
      <SectionTitle>AI / Code</SectionTitle>
      <div className="action-row">
        {(["glsl", "p5", "threejs"] as SceneType[]).map((type) => (
          <button key={type} className={`button ${selectedType === type ? "is-active" : ""}`} style={{ "--active": typeColors[type] } as React.CSSProperties} onClick={() => setSelectedType(type)}>
            {sceneTypeLabel(type)}
          </button>
        ))}
      </div>
      <div className="field">
        <label>Prompt</label>
        <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Describe the visual effect..." />
      </div>
      <button className="button is-purple" disabled={disabled} onClick={() => onGenerate(selectedType, prompt.trim())}>
        {generating ? "Generating..." : "Generate New Scene"}
      </button>
      <button className="button" disabled={!onEdit || disabled} onClick={() => onEdit?.(prompt.trim())}>
        {selectedScene ? `Edit ${selectedScene.name}` : "Select Scene To Edit"}
      </button>
      <div className="subpanel auto-vj">
        <div className="auto-vj__header">
          <SectionTitle>Auto VJ</SectionTitle>
          <button
            className={`button ${autoVJ.enabled ? "is-primary" : ""}`}
            disabled={!config.apiKey}
            onClick={() => onAutoVJChange({ enabled: !autoVJ.enabled })}
          >
            {autoVJ.enabled ? "Auto On" : "Auto Off"}
          </button>
        </div>
        <InfoGrid rows={[
          ["Mood", autoStatus.mood.label],
          ["Tags", autoStatus.mood.tags || "-"],
          ["Energy", autoStatus.mood.energy.toFixed(2)],
          ["Next", autoStatus.nextTrigger],
          ["Action", autoStatus.lastAction],
        ]} />
        <div className="field">
          <label>Scene Type</label>
          <select value={autoVJ.sceneType} onChange={(e) => onAutoVJChange({ sceneType: e.target.value as AutoSceneType })}>
            <option value="auto">Auto</option>
            <option value="glsl">GLSL</option>
            <option value="p5">P5</option>
            <option value="threejs">Three</option>
          </select>
        </div>
        <MiniSlider label="Bars" value={autoVJ.intervalBars} min={1} max={16} step={1} onChange={(value) => onAutoVJChange({ intervalBars: Math.round(value) })} />
        <MiniSlider label="Decision s" value={autoVJ.decisionSeconds} min={10} max={60} step={5} onChange={(value) => onAutoVJChange({ decisionSeconds: Math.round(value) })} />
        <MiniSlider label="Hold s" value={autoVJ.minSceneSeconds} min={15} max={120} step={5} onChange={(value) => onAutoVJChange({ minSceneSeconds: Math.round(value) })} />
        <MiniSlider label="Gen Cool s" value={autoVJ.generateCooldownSeconds} min={30} max={240} step={10} onChange={(value) => onAutoVJChange({ generateCooldownSeconds: Math.round(value) })} />
        <MiniSlider label="Fade s" value={autoVJ.transitionSeconds} min={1} max={12} step={0.5} onChange={(value) => onAutoVJChange({ transitionSeconds: value })} />
        <MiniSlider label="Keep AI" value={autoVJ.maxScenes} min={2} max={32} step={1} onChange={(value) => onAutoVJChange({ maxScenes: Math.round(value) })} />
        <div className="auto-vj__meters">
          {[
            ["Bass", autoStatus.mood.bass],
            ["Mid", autoStatus.mood.mid],
            ["Treble", autoStatus.mood.treble],
          ].map(([label, value]) => (
            <div key={label as string} className="auto-vj__meter">
              <span>{label}</span>
              <div><span style={{ width: `${Math.max(2, (value as number) * 100)}%` }} /></div>
            </div>
          ))}
        </div>
        <MoodScoreBars moods={audio.moodPredictions} />
        <div className="auto-vj__log" aria-label="Auto VJ activity log">
          {autoLog.length ? autoLog.map((entry) => (
            <div key={entry.id} className={`auto-vj__log-line is-${entry.kind.toLowerCase()}`}>
              <span>{entry.time}</span>
              <span>{entry.kind}</span>
              <span>{entry.message}</span>
            </div>
          )) : (
            <div className="auto-vj__log-empty">No Auto VJ decisions yet.</div>
          )}
        </div>
        {!config.apiKey && <p className="help">Set an API key before enabling automation.</p>}
        {!audio.enabled && <p className="help">Start audio capture for beat-locked switching.</p>}
      </div>
      <button className="button is-ghost" onClick={() => setShowSettings(!showSettings)}>
        {showSettings ? "Hide API Settings" : "API Settings"}
      </button>
      {showSettings && (
        <div className="subpanel">
          <LabeledInput label="Base URL" value={config.baseUrl} onChange={(value) => onConfigChange({ baseUrl: value })} placeholder="https://api.openai.com/v1" />
          <LabeledInput label="API Key" type="password" value={config.apiKey} onChange={(value) => onConfigChange({ apiKey: value })} placeholder="sk-..." />
          <LabeledInput label="Model" value={config.model} onChange={(value) => onConfigChange({ model: value })} placeholder="gpt-4o" />
        </div>
      )}
      {error && <div className="subpanel error-text">{error}</div>}
    </div>
  );
}

function MoodScoreBars({ moods }: { moods: AudioAnalysis["moodPredictions"] }) {
  if (!moods.length) {
    return null;
  }

  return (
    <div className="mood-scores" aria-label="Mood classifier scores">
      {moods.map((mood) => (
        <div key={mood.label} className="mood-score">
          <span>{mood.label}</span>
          <div><span style={{ width: `${Math.max(2, mood.confidence * 100)}%` }} /></div>
          <strong>{(mood.confidence * 100).toFixed(0)}%</strong>
        </div>
      ))}
    </div>
  );
}

function LedWorkspace() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mappingPreviewRef = useRef<HTMLDivElement>(null);
  const scenes = useVJStore((s) => s.scenes);
  const layoutFileInputRef = useRef<HTMLInputElement>(null);
  const mapFileInputRef = useRef<HTMLInputElement>(null);
  const config = useLedStore((s) => s.config);
  const connected = useLedStore((s) => s.connected);
  const layoutInfo = useLedStore((s) => s.layoutInfo);
  const calibrationPoints = useLedStore((s) => s.calibrationPoints);
  const mappingHandles = useLedStore((s) => s.mappingHandles);
  const rawCameraPoints = useLedStore((s) => s.rawCameraPoints);
  const calibrating = useLedStore((s) => s.calibrating);
  const calibrationProgress = useLedStore((s) => s.calibrationProgress);
  const setConfig = useLedStore((s) => s.setConfig);
  const setLayoutInfo = useLedStore((s) => s.setLayoutInfo);
  const setConnected = useLedStore((s) => s.setConnected);
  const setCalibrationPoints = useLedStore((s) => s.setCalibrationPoints);
  const setMappingHandles = useLedStore((s) => s.setMappingHandles);
  const setRawCameraPoints = useLedStore((s) => s.setRawCameraPoints);
  const setCalibrating = useLedStore((s) => s.setCalibrating);
  const setCalibrationProgress = useLedStore((s) => s.setCalibrationProgress);
  const resetCalibration = useLedStore((s) => s.resetCalibration);
  const [cameras, setCameras] = useState<CameraDevice[]>([]);
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [cameraStatus, setCameraStatus] = useState("Camera stopped");
  const [error, setError] = useState<string | null>(null);

  const stopCamera = useCallback(() => {
    setCameraStream((stream) => {
      stream?.getTracks().forEach((track) => track.stop());
      return null;
    });
    setCameraStatus("Camera stopped");
  }, []);

  useEffect(() => stopCamera, [stopCamera]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !cameraStream) return;
    attachCameraStream(video, cameraStream)
      .then(setCameraStatus)
      .catch((e) => setError(`Camera preview: ${String(e)}`));
  }, [cameraStream]);

  const refreshCameras = useCallback(async () => {
    try {
      setError(null);
      const devices = await listCalibrationCameras();
      setCameras(devices);
      if (!config.cameraDeviceId && devices[0]) {
        setConfig({ cameraDeviceId: devices[0].deviceId });
      }
    } catch (e) {
      setError(`Camera list: ${String(e)}`);
    }
  }, [config.cameraDeviceId, setConfig]);

  const startCamera = useCallback(async () => {
    try {
      setError(null);
      const stream = await startCalibrationCamera(config.cameraDeviceId);
      stopCamera();
      setCameraStream(stream);
      const devices = await listCalibrationCameras();
      setCameras(devices);
    } catch (e) {
      setError(`Camera: ${String(e)}`);
    }
  }, [config.cameraDeviceId, stopCamera]);

  const ensureLedSender = useCallback(async () => {
    if (config.layoutContent) {
      const info = await ledLoadLayoutJson(config.layoutContent);
      setLayoutInfo(info);
      setConnected(true);
      return info;
    }
    if (config.layoutPath) {
      const info = await ledLoadLayout(config.layoutPath);
      setLayoutInfo(info);
      setConnected(true);
      return info;
    }
    const info = await ledInitSimple(config.broadcastIp, config.port, config.deviceId, config.pixelCount);
    setLayoutInfo(info);
    setConnected(true);
    return info;
  }, [config, setConnected, setLayoutInfo]);

  const loadLayoutFile = useCallback(async () => {
    layoutFileInputRef.current?.click();
  }, []);

  const onLayoutFileChange = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    try {
      setError(null);
      const file = event.currentTarget.files?.[0];
      event.currentTarget.value = "";
      if (!file) return;
      const content = await file.text();
      setConfig({ layoutPath: file.name, layoutContent: content });
      const info = await ledLoadLayoutJson(content);
      setLayoutInfo(info);
      setConnected(true);
    } catch (e) {
      setConnected(false);
      setError(`Layout: ${String(e)}`);
    }
  }, [setConfig, setConnected, setLayoutInfo]);

  const clearLayoutFile = useCallback(() => {
    setConfig({ layoutPath: null, layoutContent: null });
    setLayoutInfo(null);
    setConnected(false);
  }, [setConfig, setConnected, setLayoutInfo]);

  const exportLedMap = useCallback(() => {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    downloadJson(`vjled-map-${stamp}.json`, {
      app: "vjled",
      type: "led-map",
      version: 1,
      savedAt: new Date().toISOString(),
      led: {
        config,
        layoutInfo,
        mappingHandles,
        rawCameraPoints,
        calibrationPoints,
      },
    });
  }, [calibrationPoints, config, layoutInfo, mappingHandles, rawCameraPoints]);

  const loadLedMap = useCallback(() => {
    mapFileInputRef.current?.click();
  }, []);

  const onMapFileChange = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    try {
      setError(null);
      const file = event.currentTarget.files?.[0];
      event.currentTarget.value = "";
      if (!file) return;
      const parsed = parseLedMapExport(JSON.parse(await file.text()));
      if (parsed.config) setConfig({ ...parsed.config, enabled: config.enabled });
      setLayoutInfo(parsed.layoutInfo);
      setMappingHandles(parsed.mappingHandles);
      setRawCameraPoints(parsed.rawCameraPoints);
      setCalibrationPoints(parsed.calibrationPoints.length > 0
        ? parsed.calibrationPoints
        : mapCameraToVideo(parsed.mappingHandles, parsed.rawCameraPoints));
      setConnected(false);
    } catch (e) {
      setError(`Map import: ${String(e)}`);
    }
  }, [config.enabled, setCalibrationPoints, setConfig, setConnected, setLayoutInfo, setMappingHandles, setRawCameraPoints]);

  const updateMappingHandle = useCallback((index: number, clientX: number, clientY: number) => {
    const preview = mappingPreviewRef.current;
    if (!preview) return;
    const rect = preview.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const x = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
    const next = [...mappingHandles];
    next[index] = [x, y];
    setMappingHandles(next);
    if (rawCameraPoints.length > 0) {
      setCalibrationPoints(mapCameraToVideo(next, rawCameraPoints));
    }
  }, [mappingHandles, rawCameraPoints, setCalibrationPoints, setMappingHandles]);

  const fillAllLeds = useCallback(async (r: number, g: number, b: number) => {
    try {
      setError(null);
      await ensureLedSender();
      await ledFill(r, g, b);
    } catch (e) {
      setError(`LED fill: ${String(e)}`);
    }
  }, [ensureLedSender]);

  const turnOffLeds = useCallback(async () => {
    try {
      setError(null);
      await ensureLedSender();
      await ledAllOff();
    } catch (e) {
      setError(`LED off: ${String(e)}`);
    }
  }, [ensureLedSender]);

  const captureFrame = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || video.videoWidth <= 0 || video.videoHeight <= 0) return null;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    return rgbaFromCanvas(canvas);
  }, []);

  const averageFrames = useCallback((frames: NonNullable<ReturnType<typeof captureFrame>>[]) => {
    const first = frames[0];
    if (!first) return null;
    const data = new Array(first.data.length).fill(0);
    for (const frame of frames) {
      if (frame.width !== first.width || frame.height !== first.height || frame.data.length !== first.data.length) {
        return null;
      }
      for (let i = 0; i < data.length; i++) data[i] += frame.data[i];
    }
    for (let i = 0; i < data.length; i++) data[i] = Math.round(data[i] / frames.length);
    return { data, width: first.width, height: first.height };
  }, []);

  const lumaDelta = useCallback((a: NonNullable<ReturnType<typeof captureFrame>>, b: NonNullable<ReturnType<typeof captureFrame>>) => {
    if (a.width !== b.width || a.height !== b.height || a.data.length !== b.data.length) return Number.POSITIVE_INFINITY;
    const pixelCount = a.width * a.height;
    const stride = Math.max(1, Math.floor(pixelCount / 24000));
    let sum = 0;
    let count = 0;
    for (let px = 0; px < pixelCount; px += stride) {
      const idx = px * 4;
      const la = 0.2126 * a.data[idx] + 0.7152 * a.data[idx + 1] + 0.0722 * a.data[idx + 2];
      const lb = 0.2126 * b.data[idx] + 0.7152 * b.data[idx + 1] + 0.0722 * b.data[idx + 2];
      sum += Math.abs(la - lb);
      count++;
    }
    return count > 0 ? sum / count : Number.POSITIVE_INFINITY;
  }, []);

  const captureStableOffFrame = useCallback(async () => {
    const stableFrames: NonNullable<ReturnType<typeof captureFrame>>[] = [];
    let previous = captureFrame();
    if (!previous) return null;
    for (let i = 0; i < 10; i++) {
      await waitMs(60);
      const frame = captureFrame();
      if (!frame) continue;
      if (lumaDelta(previous, frame) < 1.8) {
        stableFrames.push(frame);
        if (stableFrames.length >= 3) break;
      } else {
        stableFrames.length = 0;
      }
      previous = frame;
    }
    if (stableFrames.length > 0) return averageFrames(stableFrames);
    return previous;
  }, [averageFrames, captureFrame, lumaDelta]);

  const captureAveragedLitFrame = useCallback(async () => {
    const frames: NonNullable<ReturnType<typeof captureFrame>>[] = [];
    for (let i = 0; i < 4; i++) {
      if (i > 0) await waitMs(45);
      const frame = captureFrame();
      if (frame) frames.push(frame);
    }
    return averageFrames(frames);
  }, [averageFrames, captureFrame]);

  const runCalibration = useCallback(async () => {
    if (!cameraStream) {
      setError("Start camera first");
      return;
    }
    setCalibrating(true);
    resetCalibration();
    setError(null);

    try {
      const info = layoutInfo ?? await ensureLedSender();
      await calibrationReset();
      await ledAllOff();
      await waitMs(Math.max(500, config.calibrationOffDelayMs));

      const rawPoints = [];
      setRawCameraPoints([]);
      setCalibrationPoints([]);
      for (let i = 0; i < info.total_pixels; i++) {
        setCalibrationProgress((i + 1) / info.total_pixels);
        let detected: [number, number] | null = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          await ledAllOff();
          await waitMs(config.calibrationOffDelayMs);
          const baseline = await captureStableOffFrame();
          if (!baseline) continue;
          await calibrationSetBaseline(baseline.data, baseline.width, baseline.height);
          await ledSetPixel(i, 255, 255, 255);
          await waitMs(config.calibrationOnDelayMs);
          const frame = await captureAveragedLitFrame();
          if (!frame) continue;
          detected = await calibrationDetectLed(frame.data, frame.width, frame.height);
          if (detected) break;
        }
        if (detected) {
          rawPoints.push({ lanternId: i, x: detected[0], y: detected[1] });
          setRawCameraPoints([...rawPoints]);
          setCalibrationPoints(mapCameraToVideo(mappingHandles, rawPoints));
        }
      }

      await ledAllOff();
    } catch (e) {
      setError(`Calibration: ${String(e)}`);
    } finally {
      setCalibrating(false);
    }
  }, [cameraStream, config.calibrationOffDelayMs, config.calibrationOnDelayMs, layoutInfo, ensureLedSender, captureStableOffFrame, captureAveragedLitFrame, mappingHandles, resetCalibration, setCalibrating, setCalibrationPoints, setCalibrationProgress, setRawCameraPoints]);

  const targetMode = layoutInfo && layoutInfo.device_count > 1
    ? "Per ESP"
    : config.broadcastIp === "255.255.255.255" || config.broadcastIp.endsWith(".255")
      ? "Broadcast"
      : "Direct";
  const devices = layoutInfo?.devices ?? [{
    key: "default",
    device_id: config.deviceId,
    controller_ip: config.broadcastIp,
    total_pixels: config.pixelCount,
  }];
  return (
    <aside className="feature-panel led-feature">
      <SectionTitle>LED</SectionTitle>
      <div className="led-feature__header">
        <button className={`button ${config.enabled ? "is-danger" : "is-primary"}`} onClick={async () => {
          if (config.enabled) {
            setConfig({ enabled: false });
            return;
          }
          try {
            setError(null);
            await ensureLedSender();
            setConfig({ enabled: true });
          } catch (e) {
            setError(`LED sender: ${String(e)}`);
          }
        }}>
          {config.enabled ? "Stop Output" : "Start Output"}
        </button>
      </div>
      <InfoGrid rows={[
        ["Output", config.enabled ? "Running" : "Stopped"],
        ["Sender", connected ? "Ready" : "Not prepared"],
        ["Target", `${targetMode} ${config.broadcastIp}:${config.port}`],
        ["Pixels", String(layoutInfo?.total_pixels ?? config.pixelCount)],
        ["Source", scenes.find((scene) => scene.id === config.sourceSceneId)?.name ?? "Program Output"],
        ["Video samples", String(calibrationPoints.length)],
      ]} />
      <div className="led-feature__grid">
        <div className="subpanel">
          <div className="eyebrow">Source</div>
          <div className="field">
            <label>LED Scene</label>
            <select value={config.sourceSceneId ?? ""} onChange={(e) => setConfig({ sourceSceneId: e.target.value || null })}>
              <option value="">Program Output</option>
              {scenes.map((scene) => (
                <option key={scene.id} value={scene.id} disabled={scene.renderPaused}>
                  {scene.name} ({sceneTypeLabel(scene.type)}{scene.renderPaused ? ", paused" : ""})
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="subpanel">
          <div className="eyebrow">Layout</div>
          <div className="led-layout-row">
            <span className="led-path" title={config.layoutPath ?? "Simple UDP target"}>
              {config.layoutPath ?? "Simple UDP target"}
            </span>
            <button className="button" onClick={loadLayoutFile}>Load JSON</button>
            <input
              ref={layoutFileInputRef}
              type="file"
              accept="application/json,.json"
              onChange={onLayoutFileChange}
              style={{ display: "none" }}
            />
          </div>
          {config.layoutPath && (
            <button className="button is-ghost" onClick={clearLayoutFile}>Use Simple Target</button>
          )}
          <div className="led-config-grid">
            <div className="field">
              <label>Target IP</label>
              <input value={config.broadcastIp} onChange={(e) => setConfig({ broadcastIp: e.target.value })} />
            </div>
            <div className="field">
              <label>Port</label>
              <input type="number" min={1} max={65535} value={config.port} onChange={(e) => setConfig({ port: Math.max(1, Math.min(65535, parseInt(e.target.value, 10) || 1)) })} />
            </div>
            <div className="field">
              <label>Device</label>
              <input type="number" min={0} value={config.deviceId} onChange={(e) => setConfig({ deviceId: Math.max(0, parseInt(e.target.value, 10) || 0) })} />
            </div>
            <div className="field">
              <label>Pixels</label>
              <input type="number" min={1} value={config.pixelCount} onChange={(e) => setConfig({ pixelCount: Math.max(1, parseInt(e.target.value, 10) || 1) })} />
            </div>
          </div>
        </div>

        <div className="subpanel">
          <div className="eyebrow">Topology</div>
          {devices.map((device) => (
            <div key={device.key} className="info-grid__row">
              <span className="info-grid__label">{device.key} id:{device.device_id}</span>
              <span className="info-grid__value">{device.controller_ip} / {device.total_pixels}px</span>
            </div>
          ))}
        </div>

        <div className="subpanel led-calibration-panel">
          <div className="eyebrow">Calibrate / Map</div>
          <div className="led-calibration-panel__body">
            <div className="led-camera-preview" ref={mappingPreviewRef}>
              <video ref={videoRef} muted playsInline />
              <svg viewBox="0 0 100 100" preserveAspectRatio="none">
                <polygon className="led-map-preview__shape" points={mappingHandles.map(([x, y]) => `${x * 100},${y * 100}`).join(" ")} />
                {rawCameraPoints.map((point) => (
                  <circle className="led-map-preview__raw" key={`raw-${point.lanternId}`} cx={point.x * 100} cy={point.y * 100} r="0.9" />
                ))}
                {mappingHandles.map(([x, y], index) => (
                  <circle
                    className="led-map-preview__handle"
                    key={`handle-${index}`}
                    cx={x * 100}
                    cy={y * 100}
                    r="3.2"
                    tabIndex={0}
                    onPointerDown={(e) => {
                      e.currentTarget.setPointerCapture(e.pointerId);
                      updateMappingHandle(index, e.clientX, e.clientY);
                    }}
                    onPointerMove={(e) => {
                      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                        updateMappingHandle(index, e.clientX, e.clientY);
                      }
                    }}
                    onPointerUp={(e) => {
                      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                        e.currentTarget.releasePointerCapture(e.pointerId);
                      }
                    }}
                    onPointerCancel={(e) => {
                      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                        e.currentTarget.releasePointerCapture(e.pointerId);
                      }
                    }}
                  />
                ))}
              </svg>
            </div>
            <div className="led-calibration-panel__controls">
              <div className="led-corner-grid">
                {mappingHandles.map(([x, y], index) => (
                  <div key={index} className="led-corner-row">
                    <span className="info-grid__label">{index + 1}</span>
                    <input value={x.toFixed(2)} type="number" min={0} max={1} step={0.01} onChange={(e) => {
                      const next = [...mappingHandles];
                      next[index] = [Math.max(0, Math.min(1, parseFloat(e.target.value) || 0)), y];
                      setMappingHandles(next);
                      if (rawCameraPoints.length > 0) setCalibrationPoints(mapCameraToVideo(next, rawCameraPoints));
                    }} />
                    <input value={y.toFixed(2)} type="number" min={0} max={1} step={0.01} onChange={(e) => {
                      const next = [...mappingHandles];
                      next[index] = [x, Math.max(0, Math.min(1, parseFloat(e.target.value) || 0))];
                      setMappingHandles(next);
                      if (rawCameraPoints.length > 0) setCalibrationPoints(mapCameraToVideo(next, rawCameraPoints));
                    }} />
                  </div>
                ))}
              </div>
              <div className="led-camera-grid">
                <button className={`button ${cameraStream ? "is-danger" : ""}`} onClick={cameraStream ? stopCamera : startCamera}>
                  {cameraStream ? "Stop Camera" : "Start Camera"}
                </button>
                <button className="button" onClick={refreshCameras}>Scan</button>
              </div>
              <select value={config.cameraDeviceId ?? ""} onChange={(e) => setConfig({ cameraDeviceId: e.target.value || null })}>
                <option value="">Default camera</option>
                {cameras.map((camera) => <option key={camera.deviceId} value={camera.deviceId}>{camera.label}</option>)}
              </select>
              <div className="led-config-grid">
                <div className="field">
                  <label>Off wait ms</label>
                  <input
                    type="number"
                    min={0}
                    max={5000}
                    step={10}
                    value={config.calibrationOffDelayMs}
                    onChange={(e) => setConfig({ calibrationOffDelayMs: clampMs(e.target.valueAsNumber, 120) })}
                  />
                </div>
                <div className="field">
                  <label>On wait ms</label>
                  <input
                    type="number"
                    min={0}
                    max={5000}
                    step={10}
                    value={config.calibrationOnDelayMs}
                    onChange={(e) => setConfig({ calibrationOnDelayMs: clampMs(e.target.valueAsNumber, 90) })}
                  />
                </div>
              </div>
              <button className="button is-primary" disabled={!cameraStream || calibrating} onClick={runCalibration}>
                {calibrating ? `Calibrating ${(calibrationProgress * 100).toFixed(0)}%` : "Auto Calibrate"}
              </button>
              <div className="led-camera-grid">
                <button className="button" onClick={() => fillAllLeds(255, 255, 255)}>All On</button>
                <button className="button" onClick={turnOffLeds}>All Off</button>
                <button className="button" onClick={loadLedMap}>Import Map</button>
                <button className="button" onClick={exportLedMap}>Export Map</button>
                <input
                  ref={mapFileInputRef}
                  type="file"
                  accept="application/json,.json"
                  onChange={onMapFileChange}
                  style={{ display: "none" }}
                />
              </div>
              <div className="info-grid__row">
                <span className="info-grid__label">Camera</span>
                <span className="info-grid__value">{cameraStatus}</span>
              </div>
              <div className="info-grid__row">
                <span className="info-grid__label">Camera / video</span>
                <span className="info-grid__value">{rawCameraPoints.length} / {calibrationPoints.length}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
      <canvas ref={canvasRef} style={{ position: "fixed", left: -10000, top: -10000, width: 1, height: 1, pointerEvents: "none", opacity: 0 }} />
      {error && <div className="subpanel error-text">{error}</div>}
    </aside>
  );
}

function VideoEditor({ scene, audio, onPick, sendCommand, getVideoInfo, onSyncChange, onKeyChange }: {
  scene: Scene;
  audio: AudioAnalysis;
  onPick: () => void;
  sendCommand: (id: string, action: string, value: unknown) => void;
  getVideoInfo: (id: string) => { currentTime: number; duration: number; playing: boolean; loop: boolean; loopStart: number; loopEnd: number; bpmLoop: boolean; beatsPerLoop: number } | null;
  onSyncChange: (sync: VideoSync) => void;
  onKeyChange: (key: SceneKeySettings) => void;
}) {
  const [playing, setPlaying] = useState(false);
  const [loop, setLoop] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [loopStart, setLoopStart] = useState(0);
  const [loopEnd, setLoopEnd] = useState(0);
  const [bpmLoop, setBpmLoop] = useState(false);
  const [beatsPerLoop, setBeatsPerLoop] = useState(4);
  const sync = scene.videoSync ?? { enabled: false, measuresPerLoop: 1 };
  const loopDuration = sync.enabled && audio.bpm > 0 ? sync.measuresPerLoop * 240 / audio.bpm : 0;

  useEffect(() => {
    const interval = setInterval(() => {
      const info = getVideoInfo(scene.id);
      if (!info) return;
      setPlaying(info.playing);
      setCurrentTime(info.currentTime);
      setDuration(info.duration);
      setLoop(info.loop);
      setLoopStart(info.loopStart);
      setLoopEnd(info.loopEnd);
      setBpmLoop(info.bpmLoop);
      setBeatsPerLoop(info.beatsPerLoop);
    }, 50);
    return () => clearInterval(interval);
  }, [scene.id, getVideoInfo]);

  return (
    <div className="video-editor">
      <div className="video-editor__file">
        <span className="video-editor__path">{scene.code || "No video selected"}</span>
        <button className="button is-active" style={{ "--active": "var(--video)" } as React.CSSProperties} onClick={onPick}>
          {scene.code ? "Change" : "Choose File"}
        </button>
      </div>
      {scene.code && (
        <>
          <SceneKeyControls scene={scene} onChange={onKeyChange} />
          <div className="action-row">
            <button className="button" onClick={() => sendCommand(scene.id, playing ? "pause" : "play", undefined)}>{playing ? "Pause" : "Play"}</button>
            <button className={`button ${loop ? "is-primary" : ""}`} onClick={() => sendCommand(scene.id, "loop", !loop)}>{loop ? "Loop" : "Once"}</button>
            <button className={`button ${bpmLoop ? "is-primary" : ""}`} onClick={() => sendCommand(scene.id, "bpmLoop", !bpmLoop)}>BPM Loop</button>
            <span className="module-meta">{formatTime(currentTime)} / {formatTime(duration)}</span>
          </div>
          <input className="range" type="range" min={0} max={duration || 0} step={0.01} value={currentTime} onChange={(e) => sendCommand(scene.id, "seek", parseFloat(e.target.value))} />
          <div className="action-row">
            <button className="button" onClick={() => sendCommand(scene.id, "loopStart", currentTime)}>Set In</button>
            <span className="module-meta">{formatTime(loopStart)} - {formatTime(loopEnd)}</span>
            <button className="button" onClick={() => sendCommand(scene.id, "loopEnd", currentTime)}>Set Out</button>
            <button className={`button ${sync.enabled ? "is-primary" : ""}`} onClick={() => onSyncChange({ ...sync, enabled: !sync.enabled })}>
              {sync.enabled ? "Sync On" : "Sync Off"}
            </button>
            <select value={beatsPerLoop} onChange={(e) => sendCommand(scene.id, "beatsPerLoop", parseInt(e.target.value, 10))}>
              {[1, 2, 4, 8, 16, 32].map((beats) => <option key={beats} value={beats}>{beats} beats</option>)}
            </select>
            {loopDuration > 0 && <span className="module-meta">{loopDuration.toFixed(2)}s / loop</span>}
          </div>
        </>
      )}
    </div>
  );
}

function ModePad({ mix, onChange }: { mix: MixSettings; onChange: (mix: Partial<MixSettings>) => void }) {
  return (
    <div className="mode-pad">
      <div>
        <SectionTitle>Blend</SectionTitle>
        <div className="mode-grid">
          {blendModes.map((mode) => (
            <button key={mode} className={`button ${mix.mode === mode ? "is-primary" : ""}`} onClick={() => onChange({ mode })}>{mixLabels[mode]}</button>
          ))}
        </div>
      </div>
      <div>
        <SectionTitle>Switch</SectionTitle>
        <div className="mode-grid">
          {transitionModes.map((mode) => (
            <button key={mode} className={`button ${mix.mode === mode ? "is-primary" : ""}`} onClick={() => onChange({ mode })}>{mixLabels[mode]}</button>
          ))}
        </div>
      </div>
      <MiniSlider label="Intensity" value={mix.intensity} min={0} max={1} step={0.01} onChange={(value) => onChange({ intensity: value })} />
      <MiniSlider label="Feather" value={mix.feather} min={0.001} max={0.5} step={0.005} onChange={(value) => onChange({ feather: value })} />
    </div>
  );
}

function SceneKeyControls({ scene, onChange, compact = false }: { scene: Scene; onChange: (key: SceneKeySettings) => void; compact?: boolean }) {
  const key = scene.key ?? defaultSceneKey;
  const setKey = (patch: Partial<SceneKeySettings>) => onChange({ ...key, ...patch });
  return (
    <div className={`key-panel ${compact ? "is-compact" : ""}`}>
      <button className={`button ${key.enabled ? "is-active" : ""}`} style={{ "--active": typeColors[scene.type] } as React.CSSProperties} onClick={() => setKey({ enabled: !key.enabled })}>
        {key.enabled ? "Black Key On" : "Black Key Off"}
      </button>
      <MiniSlider label="Threshold" value={key.threshold} min={0} max={0.6} step={0.005} disabled={!key.enabled} onChange={(value) => setKey({ threshold: value })} />
      <MiniSlider label="Softness" value={key.softness} min={0.001} max={0.5} step={0.005} disabled={!key.enabled} onChange={(value) => setKey({ softness: value })} />
      <MiniSlider label="Spill" value={key.spill} min={0} max={1} step={0.01} disabled={!key.enabled} onChange={(value) => setKey({ spill: value })} />
    </div>
  );
}

function MiniSlider({ label, value, min, max, step, disabled = false, onChange }: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <label className={`mini-slider ${disabled ? "is-disabled" : ""}`}>
      <span>{label}</span>
      <input className="range" disabled={disabled} type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(parseFloat(e.target.value))} />
      <span>{step >= 1 ? Math.round(value) : value.toFixed(2)}</span>
    </label>
  );
}

function InfoGrid({ rows }: { rows: [string, string][] }) {
  return (
    <div className="info-grid">
      {rows.map(([label, value]) => (
        <div className="info-grid__row" key={label}>
          <span className="info-grid__label">{label}</span>
          <span className="info-grid__value">{value}</span>
        </div>
      ))}
    </div>
  );
}

function LabeledInput({ label, value, onChange, placeholder, type = "text" }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <div className="field">
      <label>{label}</label>
      <input type={type} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
    </div>
  );
}

function outputMeta(selected: Scene | null, a: Scene | undefined, b: Scene | undefined, crossfade: number, mix: MixSettings): string {
  const sourceA = a ?? b ?? selected ?? undefined;
  const sourceB = a ? b : undefined;
  if (!sourceA && !sourceB) return "no source assigned";
  if (!sourceA) return "no source assigned";
  if (!sourceB) return sourceA.name;
  if (crossfade <= 0.01) return sourceA.name;
  if (crossfade >= 0.99) return sourceB.name;
  return `${mixLabels[mix.mode]} ${sourceA.name} -> ${sourceB.name}`;
}

function bandAverage(values: number[], start: number, end: number): number {
  const slice = values.slice(start, end);
  if (slice.length === 0) return 0;
  return Math.max(0, Math.min(1, slice.reduce((sum, value) => sum + value, 0) / slice.length));
}

function formatMoodPredictions(moods: AudioAnalysis["moodPredictions"] | undefined): string {
  const values = moods ?? [];
  return values.length
    ? values.map((mood) => `${mood.label} ${(mood.confidence * 100).toFixed(0)}%`).join(", ")
    : "unknown";
}

function primaryEssentiaMood(moods: AudioAnalysis["moodPredictions"] | undefined): string | null {
  const primary = (moods ?? [])[0];
  if (!primary || primary.confidence < 0.55) return null;
  if (primary.label === "Danceable") return "Danceable";
  return primary.label;
}

function trimAudioHistory(history: AudioSnapshot[], seconds: number): AudioSnapshot[] {
  const latest = history[history.length - 1]?.at ?? 0;
  return history.filter((snapshot) => latest - snapshot.at <= seconds * 1000);
}

function summarizeAudioHistory(history: AudioSnapshot[], mood: AudioMood): AudioSummary {
  const fallback: AudioSnapshot = {
    at: performance.now(),
    bpm: 0,
    beat: false,
    beatCount: 0,
    energy: mood.energy,
    bass: mood.bass,
    mid: mood.mid,
    treble: mood.treble,
    tags: [],
  };
  const current = history[history.length - 1] ?? fallback;
  const window = history.length ? history.filter((snapshot) => current.at - snapshot.at <= 30_000) : [current];
  const recent = window.filter((snapshot) => current.at - snapshot.at <= 10_000);
  const previous = window.filter((snapshot) => current.at - snapshot.at > 10_000);
  const averageEnergy = average(window.map((snapshot) => snapshot.energy));
  const energyDelta = average(recent.map((snapshot) => snapshot.energy)) - average(previous.length ? previous.map((snapshot) => snapshot.energy) : window.map((snapshot) => snapshot.energy));
  const bpmValues = window.map((snapshot) => snapshot.bpm).filter((bpm) => bpm > 0);
  const bpm = bpmValues.length ? average(bpmValues) : current.bpm;
  const bpmStable = bpmValues.length > 4 ? Math.max(...bpmValues) - Math.min(...bpmValues) < 4 : bpm > 0;
  const topTags = aggregateTags(window);
  const recentTags = aggregateTags(recent);
  const previousTags = aggregateTags(previous);
  const previousByLabel = new Map(previousTags.map((tag) => [tag.label, tag.confidence]));
  const risingTags = recentTags
    .filter((tag) => tag.confidence - (previousByLabel.get(tag.label) ?? 0) > 0.08)
    .slice(0, 3)
    .map((tag) => tag.label);
  const recentByLabel = new Map(recentTags.map((tag) => [tag.label, tag.confidence]));
  const fadingTags = previousTags
    .filter((tag) => tag.confidence - (recentByLabel.get(tag.label) ?? 0) > 0.08)
    .slice(0, 3)
    .map((tag) => tag.label);

  return {
    windowSeconds: window.length > 1 ? (current.at - window[0].at) / 1000 : 0,
    current,
    averageEnergy,
    energyDelta,
    bpm,
    bpmStable,
    topTags,
    risingTags,
    fadingTags,
  };
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function aggregateTags(history: AudioSnapshot[]): { label: string; confidence: number }[] {
  const sums = new Map<string, { label: string; total: number; count: number }>();
  for (const snapshot of history) {
    for (const tag of snapshot.tags) {
      const key = tag.label.toLowerCase();
      const current = sums.get(key) ?? { label: tag.label, total: 0, count: 0 };
      current.total += tag.confidence;
      current.count += 1;
      sums.set(key, current);
    }
  }
  return [...sums.values()]
    .map((tag) => ({ label: tag.label, confidence: tag.total / tag.count }))
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 6);
}

function formatTagList(tags: { label: string; confidence: number }[]): string {
  if (tags.length === 0) return "unknown";
  return tags.slice(0, 4).map((tag) => `${tag.label} ${(tag.confidence * 100).toFixed(0)}%`).join(", ");
}

function formatAge(seconds: number): string {
  if (!Number.isFinite(seconds)) return "none";
  return `${seconds.toFixed(0)}s`;
}

async function generateVisuallyValidCode(
  generate: (sceneType: string, prompt: string, existingCode?: string) => Promise<string>,
  sceneType: SceneType,
  prompt: string,
  existingCode: string | undefined,
  audio: AudioAnalysis,
): Promise<string> {
  if (sceneType === "video") {
    return generate(sceneType, prompt, existingCode);
  }

  let repairCode = existingCode;
  let repairPrompt = prompt;
  let lastError = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = await generate(sceneType, repairPrompt, repairCode);
    const result = await validateRenderedCode(sceneType, code, audio);
    if (result.ok) return code;

    lastError = result.reason;
    console.warn(`[AI visual validation] ${sceneType} attempt ${attempt + 1} failed: ${lastError}`);
    repairCode = code;
    repairPrompt = [
      prompt,
      "",
      `The previous ${sceneType} code rendered incorrectly: ${lastError}.`,
      "Regenerate a complete replacement that visibly renders within the first second.",
      "It must not be nearly all black, nearly all white, transparent, or static.",
      "Use a dark/stage background with bright colored foreground shapes, and make motion obvious even if audio is quiet.",
    ].join("\n");
  }

  throw new Error(`AI visual validation failed after 3 attempts: ${lastError}`);
}

async function validateRenderedCode(sceneType: SceneType, code: string, audio: AudioAnalysis): Promise<{ ok: true } | { ok: false; reason: string }> {
  const renderer = await createRenderer(sceneType);
  if (!renderer) return { ok: false, reason: "renderer could not be created" };

  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 180;
  const validationAudio = audio.enabled
    ? audio
    : {
        ...emptyAudioAnalysis,
        enabled: true,
        permission: "ready" as const,
        bpm: 124,
        beat: true,
        beatPhase: 0,
        beatCount: 1,
        fft: Array.from({ length: 32 }, (_, i) => (i < 6 ? 0.72 : i < 18 ? 0.42 : 0.3)),
      };

  try {
    renderer.init(canvas);
    renderer.setCode(code);
    const frames: ImageData[] = [];
    const readCanvas = document.createElement("canvas");
    readCanvas.width = canvas.width;
    readCanvas.height = canvas.height;
    const readCtx = readCanvas.getContext("2d", { willReadFrequently: true });
    if (!readCtx) return { ok: false, reason: "validation canvas could not be read" };
    for (let i = 0; i < 8; i++) {
      const beat = i === 0 || i === 4;
      renderer.update(i / 12, 1 / 12, {
        ...validationAudio,
        beat,
        beatPhase: (i % 4) / 4,
        beatCount: validationAudio.beatCount + (beat ? i : 0),
      });
      await nextFrame();
      readCtx.clearRect(0, 0, readCanvas.width, readCanvas.height);
      readCtx.drawImage(canvas, 0, 0, readCanvas.width, readCanvas.height);
      frames.push(readCtx.getImageData(0, 0, readCanvas.width, readCanvas.height));
    }
    return analyzeRenderedFrames(frames);
  } catch (error) {
    return { ok: false, reason: `renderer threw during validation: ${String(error)}` };
  } finally {
    renderer.destroy();
    canvas.remove();
  }
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function analyzeRenderedFrames(frames: ImageData[]): { ok: true } | { ok: false; reason: string } {
  if (frames.length === 0) return { ok: false, reason: "no frames rendered" };

  let lumaSum = 0;
  let lumaSqSum = 0;
  let colorSpreadSum = 0;
  let alphaSum = 0;
  let samples = 0;
  const stride = Math.max(4, Math.floor(frames[0].data.length / 4 / 6000) * 4);

  for (const frame of frames) {
    for (let i = 0; i < frame.data.length; i += stride) {
      const r = frame.data[i];
      const g = frame.data[i + 1];
      const b = frame.data[i + 2];
      const a = frame.data[i + 3];
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      lumaSum += luma;
      lumaSqSum += luma * luma;
      colorSpreadSum += Math.max(r, g, b) - Math.min(r, g, b);
      alphaSum += a;
      samples++;
    }
  }

  const mean = lumaSum / Math.max(1, samples);
  const variance = lumaSqSum / Math.max(1, samples) - mean * mean;
  const contrast = Math.sqrt(Math.max(0, variance));
  const colorSpread = colorSpreadSum / Math.max(1, samples);
  const alpha = alphaSum / Math.max(1, samples);
  const motion = averageFrameDelta(frames, stride);

  if (alpha < 8) return { ok: false, reason: `nearly transparent output (alpha ${alpha.toFixed(1)})` };
  if (mean < 4 && contrast < 5) return { ok: false, reason: `nearly black output (luma ${mean.toFixed(1)}, contrast ${contrast.toFixed(1)})` };
  if (mean > 248 && contrast < 5) return { ok: false, reason: `nearly white output (luma ${mean.toFixed(1)}, contrast ${contrast.toFixed(1)})` };
  if (contrast < 3 && colorSpread < 3) return { ok: false, reason: `flat solid output (contrast ${contrast.toFixed(1)}, color ${colorSpread.toFixed(1)})` };
  if (motion < 0.35) return { ok: false, reason: `static output (frame delta ${motion.toFixed(2)})` };
  return { ok: true };
}

function averageFrameDelta(frames: ImageData[], stride: number): number {
  if (frames.length < 2) return 0;
  let total = 0;
  let pairs = 0;
  for (let f = 1; f < frames.length; f++) {
    const prev = frames[f - 1].data;
    const next = frames[f].data;
    let sum = 0;
    let count = 0;
    for (let i = 0; i < next.length; i += stride) {
      sum += (
        Math.abs(next[i] - prev[i])
        + Math.abs(next[i + 1] - prev[i + 1])
        + Math.abs(next[i + 2] - prev[i + 2])
      ) / 3;
      count++;
    }
    total += sum / Math.max(1, count);
    pairs++;
  }
  return total / Math.max(1, pairs);
}

function shouldAutoGenerate(sceneAgeSeconds: number, generateCooldownSeconds: number, settings: AutoVJSettings): boolean {
  const staleSceneSeconds = Math.max(settings.minSceneSeconds * 1.2, 30);
  return sceneAgeSeconds >= staleSceneSeconds && generateCooldownSeconds >= settings.generateCooldownSeconds;
}

function parseAutoVJDecision(raw: string): Partial<AutoVJDecision> {
  const jsonStart = raw.indexOf("{");
  const jsonEnd = raw.lastIndexOf("}");
  if (jsonStart < 0 || jsonEnd <= jsonStart) {
    return { action: "KEEP", confidence: 0.2, reason: "director returned non-json" };
  }
  try {
    return JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
  } catch {
    return { action: "KEEP", confidence: 0.2, reason: "director json parse failed" };
  }
}

function normalizeAutoVJDecision(
  decision: Partial<AutoVJDecision>,
  summary: AudioSummary,
  sceneAgeSeconds: number,
  generateCooldownSeconds: number,
  settings: AutoVJSettings,
): AutoVJDecision {
  const action = String(decision.action ?? "KEEP").toUpperCase();
  let normalized: AutoVJAction = action === "ACCENT" || action === "SWITCH" || action === "GENERATE" ? action : "KEEP";
  const confidence = typeof decision.confidence === "number" ? Math.max(0, Math.min(1, decision.confidence)) : 0.5;
  let reason = String(decision.reason || "stable music state").slice(0, 140);

  if (sceneAgeSeconds < settings.minSceneSeconds && (normalized === "GENERATE" || normalized === "SWITCH")) {
    normalized = Math.abs(summary.energyDelta) > 0.18 ? "ACCENT" : "KEEP";
    reason = `scene hold guard: ${reason}`;
  }
  if (normalized === "GENERATE" && generateCooldownSeconds < settings.generateCooldownSeconds) {
    normalized = Math.abs(summary.energyDelta) > 0.14 ? "SWITCH" : "ACCENT";
    reason = `generation cooldown: ${reason}`;
  }
  if (normalized === "KEEP" && sceneAgeSeconds >= settings.minSceneSeconds && Math.abs(summary.energyDelta) > 0.04) {
    normalized = "ACCENT";
    reason = `refresh bias: ${reason}`;
  }
  if (confidence < 0.25 && normalized !== "KEEP") {
    normalized = Math.abs(summary.energyDelta) > 0.16 ? "ACCENT" : "KEEP";
    reason = `low confidence: ${reason}`;
  }

  return {
    action: normalized,
    confidence,
    reason,
    targetSceneId: typeof decision.targetSceneId === "string" ? decision.targetSceneId : undefined,
    visualDirection: typeof decision.visualDirection === "string" ? decision.visualDirection.slice(0, 220) : undefined,
  };
}

function analyzeAudioMood(audio: AudioAnalysis): AudioMood {
  const fft = audio.fft.length > 0 ? audio.fft : emptyAudioAnalysis.fft;
  const bass = bandAverage(fft, 0, 5);
  const mid = bandAverage(fft, 5, 16);
  const treble = bandAverage(fft, 16, 32);
  const bpmEnergy = audio.bpm > 0 ? Math.max(0, Math.min(1, (audio.bpm - 72) / 96)) : 0.35;
  const spectralEnergy = bass * 0.42 + mid * 0.34 + treble * 0.24;
  const beatLift = audio.beat ? 0.14 : Math.max(0, 0.08 * (1 - audio.beatPhase));
  const energy = Math.max(0, Math.min(1, spectralEnergy * 0.72 + bpmEnergy * 0.22 + beatLift));
  const brightness = treble - bass;
  const lowTempo = audio.bpm > 0 && audio.bpm < 92;
  const fastTempo = audio.bpm >= 138;
  const balancedSpectrum = Math.abs(bass - mid) < 0.12 && Math.abs(mid - treble) < 0.12;

  if (!audio.enabled || audio.permission !== "ready") {
    return {
      label: "Standby",
      tags: "",
      energy: 0,
      bass: 0,
      mid: 0,
      treble: 0,
      palette: "dim monochrome with faint cyan accents",
      motion: "slow drifting",
      texture: "minimal particles and soft gradients",
    };
  }

  const tags = audio.musicTags.map((tag) => tag.label.toLowerCase());
  const moodPredictions = audio.moodPredictions ?? [];
  const primaryMood = primaryEssentiaMood(moodPredictions);
  const moodScores = new Map(moodPredictions.map((mood) => [mood.label.toLowerCase(), mood.confidence]));
  const tagSummary = [
    ...audio.musicTags.map((tag) => `${tag.label} ${(tag.confidence * 100).toFixed(0)}%`),
    ...moodPredictions.map((mood) => `${mood.label} ${(mood.confidence * 100).toFixed(0)}%`),
  ].join(", ");
  const has = (...needles: string[]) => tags.some((tag) => needles.some((needle) => tag.includes(needle)));
  const mood = (label: string) => moodScores.get(label.toLowerCase()) ?? 0;
  const vocal = has("vocal");
  const party = Math.max(mood("party"), mood("danceable"));
  const relaxed = mood("relaxed");
  const aggressive = mood("aggressive");
  const sad = mood("sad");
  const happy = mood("happy");

  const base = {
    energy,
    bass,
    mid,
    treble,
  };

  if (has("ambient", "chillout", "chill", "mellow") || relaxed > 0.62 || energy < 0.34) {
    return {
      ...base,
      label: primaryMood ?? (has("ambient") ? "Ambient Texture" : relaxed > 0.62 ? "Relaxed" : "Chill Atmosphere"),
      tags: tagSummary,
      palette: "indigo, teal, silver, soft violet, and muted green",
      motion: lowTempo ? "slow floating parallax and long phase shifts" : "gentle drifting pulses with restrained beat response",
      texture: "mist, flowing contours, soft particles, liquid gradients, and wide spatial depth",
    };
  }
  if (has("electronic", "electronica", "electro", "house", "dance") || party > 0.62 || fastTempo) {
    return {
      ...base,
      label: primaryMood ?? (has("house") ? "House Pulse" : party > 0.62 ? "Danceable" : has("electro") ? "Electro Drive" : "Electronic Motion"),
      tags: tagSummary,
      palette: energy > 0.62 ? "laser cyan, acid green, hot pink, black, and white hits" : "cyan, violet, lime, and dark graphite",
      motion: fastTempo || energy > 0.6 ? "beat-locked sweeps, tight strobes, sidechain-like expansion, and crisp cuts" : "clean sequenced pulses and gliding looped motion",
      texture: "vector grids, scanlines, waveform ribbons, sequencer blocks, and luminous trails",
    };
  }
  if (has("metal", "hard rock", "punk", "heavy metal") || aggressive > 0.62 || (bass > 0.42 && treble < 0.36)) {
    return {
      ...base,
      label: primaryMood ?? (has("punk") ? "Punk Impact" : has("metal") || has("heavy metal") ? "Metal Weight" : aggressive > 0.62 ? "Aggressive" : "Rock Weight"),
      tags: tagSummary,
      palette: "deep red, hard white, sodium amber, black, and steel blue",
      motion: "aggressive beat impacts, pressure waves, sharp camera jolts, and forward thrust",
      texture: "distressed geometry, molten streaks, cracked panels, sparks, and heavy bass ripples",
    };
  }
  if (has("rock", "alternative", "indie", "guitar", "classic rock", "progressive rock")) {
    return {
      ...base,
      label: has("indie") ? "Indie Color" : has("classic rock") ? "Classic Rock Glow" : "Rock Motion",
      tags: tagSummary,
      palette: "coral, cyan, warm gold, dirty white, and deep neutral backing",
      motion: "riff-like waves, elastic lateral pushes, beat pulses, and guitar-driven arcs",
      texture: "layered waveforms, radial motifs, feedback trails, posterized bands, and rhythmic particles",
    };
  }
  if (has("hip-hop", "funk", "soul", "rnb")) {
    return {
      ...base,
      label: has("funk") ? "Funk Bounce" : has("soul") || has("rnb") ? "Soul Groove" : "Hip-Hop Bounce",
      tags: tagSummary,
      palette: "neon green, cyan, warm orange, deep purple, and black",
      motion: "springy low-end bounces, rounded beat impacts, call-and-response accents, and syncopated steps",
      texture: "rubber shapes, bass meters, vinyl rings, warm glows, sliced panels, and elastic ripples",
    };
  }
  if (has("jazz", "blues", "folk", "acoustic", "country", "oldies", "easy listening")) {
    return {
      ...base,
      label: has("jazz") ? "Jazz Flow" : has("acoustic") || has("folk") ? "Acoustic Drift" : "Vintage Groove",
      tags: tagSummary,
      palette: "amber, ivory, muted teal, wine red, and smoky gray",
      motion: "phrased waves, soft swing, slow arcs, and breathing transitions",
      texture: "grain, contour lines, warm halos, brushed shapes, and analog light leaks",
    };
  }
  if (vocal || happy > 0.62 || has("pop", "catchy", "happy", "party", "sexy")) {
    return {
      ...base,
      label: primaryMood ?? (has("party") || has("dance") || party > 0.62 ? "Pop Party" : vocal ? "Vocal Pop" : happy > 0.62 ? "Happy" : "Pop Shine"),
      tags: tagSummary,
      palette: "aqua, saturated pink, warm yellow, white, and violet accents",
      motion: "hook-driven pulses, rising arcs, clean flashes, and bright chorus lifts",
      texture: "ribbons, spark fields, glossy panels, lyric-like contours, and light blooms",
    };
  }
  if (sad > 0.62) {
    return {
      ...base,
      label: primaryMood ?? "Sad",
      tags: tagSummary,
      palette: "deep blue, silver, muted violet, soft amber, and black",
      motion: "slow downward arcs, delayed pulses, and restrained breathing transitions",
      texture: "rain-like streaks, low clouds, sparse particles, glassy bands, and fading halos",
    };
  }
  return {
    ...base,
    label: primaryMood ?? (balancedSpectrum ? "Tagged Spectrum" : brightness > 0.08 ? "Tagged Brightness" : "Tagged Groove"),
    tags: tagSummary,
    palette: "cyan, coral, warm gold, white accents, and deep neutral backing",
    motion: "medium beat pulses, elastic lateral movement, and tag-driven variation",
    texture: "layered waves, radial motifs, spectrum grids, and rhythmic particles",
  };
}

function pickAutoSceneType(setting: AutoSceneType, mood: AudioMood, currentScenes: Scene[] = []): GenerativeSceneType {
  if (setting !== "auto") return setting;
  const label = mood.label.toLowerCase();
  let preferred: GenerativeSceneType = mood.treble > mood.bass ? "p5" : "glsl";
  if (label.includes("relaxed") || label.includes("ambient") || label.includes("chill") || label.includes("acoustic") || label.includes("jazz")) preferred = "threejs";
  if (label.includes("happy") || label.includes("pop") || label.includes("vocal") || label.includes("funk") || label.includes("hip-hop") || label.includes("indie")) preferred = "p5";
  if (label.includes("danceable") || label.includes("aggressive") || label.includes("metal") || label.includes("rock") || label.includes("electro") || label.includes("house")) preferred = "glsl";

  const recent = currentScenes.filter((scene) => scene.type !== "video").slice(-6);
  const recentAuto = currentScenes.filter((scene) => scene.name.startsWith("AI ") && scene.type !== "video").slice(-3);
  const unused = sceneTypeRotation.find((type) => !recentAuto.some((scene) => scene.type === type));
  if (unused) return unused;

  return sceneTypeRotation
    .map((type) => ({
      type,
      score: (type === preferred ? -1.4 : 0)
        + recent.filter((scene) => scene.type === type).length * 0.8
        + recentAuto.filter((scene) => scene.type === type).length * 1.2,
    }))
    .sort((a, b) => a.score - b.score)[0]?.type ?? preferred;
}

function pickAutoMixMode(mood: AudioMood): MixMode {
  const label = mood.label.toLowerCase();
  if (label.includes("danceable")) return mood.treble > 0.5 ? "rgbSplit" : "glitch";
  if (label.includes("aggressive")) return "glitch";
  if (label.includes("relaxed")) return "screen";
  if (label.includes("happy")) return "overlay";
  if (label.includes("sad")) return "screen";
  if (label.includes("electro") || label.includes("house")) return mood.treble > 0.5 ? "rgbSplit" : "glitch";
  if (label.includes("metal") || label.includes("rock")) return "glitch";
  if (label.includes("ambient") || label.includes("chill") || label.includes("acoustic")) return "screen";
  if (label.includes("pop") || label.includes("vocal")) return "overlay";
  if (label.includes("hip-hop") || label.includes("funk") || label.includes("soul")) return "rgbSplit";
  if (label.includes("jazz") || label.includes("vintage")) return "screen";
  return mood.bass > mood.treble ? "glitch" : "rgbSplit";
}

function pickAutoSwitchScene(targetSceneId: string | undefined, scenes: Scene[], busA: string | null, busB: string | null, mood: AudioMood): Scene | null {
  const liveIds = new Set([busA, busB].filter(Boolean));
  if (targetSceneId) {
    const target = scenes.find((scene) => scene.id === targetSceneId && !liveIds.has(scene.id) && !scene.renderPaused);
    if (target && target.type !== "video") return target;
  }
  const preferredType = pickAutoSceneType("auto", mood, scenes);
  const available = scenes
    .filter((scene) => !liveIds.has(scene.id) && !scene.renderPaused && scene.type !== "video")
    .sort((a, b) => sceneRecencyScore(b) - sceneRecencyScore(a));
  return available.find((scene) => scene.name.startsWith("AI ") && scene.type === preferredType)
    ?? available.find((scene) => scene.type === preferredType)
    ?? available.find((scene) => scene.name.startsWith("AI "))
    ?? available[0]
    ?? null;
}

function enforceRenderBudget(
  scenes: Scene[],
  busA: string | null,
  busB: string | null,
  selectedSceneId: string | null,
  extraProtectedIds: Set<string>,
  setSceneRenderPaused: (id: string, paused: boolean) => void,
) {
  const protectedIds = new Set([busA, busB, selectedSceneId, ...extraProtectedIds].filter(Boolean) as string[]);
  const active = scenes.filter((scene) => !scene.renderPaused && scene.type !== "video");
  if (active.length <= maxActiveRenderedScenes) return;

  const candidates = active
    .filter((scene) => !protectedIds.has(scene.id))
    .sort((a, b) => {
      const aiDelta = Number(!a.name.startsWith("AI ")) - Number(!b.name.startsWith("AI "));
      return aiDelta || sceneRecencyScore(a) - sceneRecencyScore(b);
    });
  const pauseCount = active.length - maxActiveRenderedScenes;
  for (const scene of candidates.slice(0, pauseCount)) {
    setSceneRenderPaused(scene.id, true);
  }
}

function sceneRecencyScore(scene: Scene): number {
  const match = scene.id.match(/scene-(\d+)/);
  const idScore = match ? parseInt(match[1], 10) : 0;
  return idScore + (scene.name.startsWith("AI ") ? 10_000 : 0);
}

function buildAutoDecisionPrompt(args: {
  reason: string;
  mood: AudioMood;
  summary: AudioSummary;
  sceneAgeSeconds: number;
  generateCooldownSeconds: number;
  minSceneSeconds: number;
  generateCooldownLimitSeconds: number;
  scenes: Scene[];
  busA: string | null;
  busB: string | null;
}): string {
  const sceneLines = args.scenes.map((scene) => {
    const live = scene.id === args.busA ? "live on A" : scene.id === args.busB ? "live on B" : "available";
    return `- ${scene.id}: ${scene.name} (${scene.type}, ${scene.renderPaused ? "render paused" : live})`;
  }).join("\n") || "- none";
  const tagLine = args.summary.topTags.length
    ? args.summary.topTags.map((tag) => `${tag.label} ${(tag.confidence * 100).toFixed(0)}%`).join(", ")
    : "unknown";

  return [
    `Trigger candidate: ${args.reason}`,
    `Current mood: ${args.mood.label}`,
    `Smoothed tags over ${args.summary.windowSeconds.toFixed(0)}s: ${tagLine}`,
    `Rising tags: ${args.summary.risingTags.join(", ") || "none"}`,
    `Fading tags: ${args.summary.fadingTags.join(", ") || "none"}`,
    `Energy current ${args.summary.current.energy.toFixed(2)}, average ${args.summary.averageEnergy.toFixed(2)}, delta ${args.summary.energyDelta.toFixed(2)}`,
    `BPM ${args.summary.bpm.toFixed(1)}, stable ${args.summary.bpmStable ? "yes" : "no"}`,
    `Current scene age ${Number.isFinite(args.sceneAgeSeconds) ? args.sceneAgeSeconds.toFixed(0) : "initial"}s; minimum hold ${args.minSceneSeconds}s`,
    `Time since last generation ${Number.isFinite(args.generateCooldownSeconds) ? args.generateCooldownSeconds.toFixed(0) : "none"}s; generation cooldown ${args.generateCooldownLimitSeconds}s`,
    "Scenes:",
    sceneLines,
    "Choose KEEP, ACCENT, SWITCH, or GENERATE. SWITCH must include targetSceneId when possible.",
    "Bias toward visible change: prefer ACCENT, SWITCH, or GENERATE unless the current look is clearly still working.",
    "For SWITCH, prefer newer non-paused AI scenes over older scenes, unless the older scene is clearly a better match.",
    "If the current scene is old or the music has changed and generation cooldown has elapsed, choose GENERATE.",
    "Return only strict JSON. Never return plain text.",
  ].join("\n");
}

function buildAutoPrompt(args: {
  mood: AudioMood;
  audio: AudioAnalysis;
  reason: string;
  sceneType: GenerativeSceneType;
  currentScenes: Scene[];
}): string {
  const recentAiScenes = args.currentScenes
    .filter((scene) => scene.name.startsWith("AI "))
    .slice(-4)
    .map((scene) => `${scene.name} (${scene.type})`)
    .join(", ") || "none";
  const colorSchemes = [
    "Laser Club: black base, laser cyan, acid green, hot pink, hard white",
    "Molten Impact: near-black, deep red, sodium amber, steel blue, white hits",
    "Chrome Pop: graphite, aqua, saturated pink, warm yellow, violet accents",
    "Nocturne Flow: deep indigo, teal, silver, soft violet, muted green",
    "Analog Warmth: smoky gray, amber, ivory, wine red, muted teal",
    "Digital Warning: black, electric blue, toxic lime, safety orange, white",
  ].join(" | ");

  return [
    "Create a new live VJ scene for the currently playing music.",
    "Think like a professional VJ designer preparing a stage visual, not a demo sketch.",
    "Start from a single strong concept with a clear foreground, background depth, and transition-friendly contrast.",
    `Trigger reason: ${args.reason}.`,
    `Detected mood: ${args.mood.label}.`,
    `Essentia mood scores: ${formatMoodPredictions(args.audio.moodPredictions)}.`,
    `Detected genre: ${args.audio.genre}.`,
    `Detected music tags: ${args.audio.musicTags.length ? args.audio.musicTags.map((tag) => `${tag.label} ${(tag.confidence * 100).toFixed(0)}%`).join(", ") : "unknown"}.`,
    `Audio features from the existing Aubio pipeline: BPM ${args.audio.bpm.toFixed(1)}, energy ${args.mood.energy.toFixed(2)}, bass ${args.mood.bass.toFixed(2)}, mid ${args.mood.mid.toFixed(2)}, treble ${args.mood.treble.toFixed(2)}.`,
    "Audio variable guide: BPM is tempo; beat is true/1.0 only on beat frames; beatPhase is 0.0-1.0 progress between beats; beatCount increments each beat; FFT low bins are bass, middle bins are body/mids, high bins are treble.",
    args.sceneType === "glsl"
      ? "Scene type role: GLSL is for fast abstract club visuals, shader fields, audio-reactive geometry, strobes, tunnels, grids, and clean WebGL 1 syntax."
      : args.sceneType === "threejs"
        ? "Scene type role: Three.js is for spatial visuals, real 3D objects, camera motion, depth, lighting, repeated structures, and audio-reactive transforms."
        : "Scene type role: p5 is for graphic 2D visuals, particles, typography-like marks, poster shapes, vector rhythm, trails, and bold flat color systems.",
    `Prepared color schemes to choose from or adapt: ${colorSchemes}.`,
    `Visual palette: ${args.mood.palette}.`,
    `Motion: ${args.mood.motion}.`,
    `Texture: ${args.mood.texture}.`,
    "Color direction: choose one palette, keep most of the frame on 2-3 dominant colors, reserve the brightest color for beat accents, and avoid muddy full-spectrum rainbows.",
    "Composition direction: make the image readable on a dark stage and on LEDs; avoid tiny details as the main subject; use large masses, clear rhythm, and high contrast.",
    "Motion direction: make bass affect large scale/impact, mids affect shape density or formation changes, and treble affect small highlights, lines, particles, or shimmer.",
    "Variation direction: include slow evolution over 16 bars plus beat-level accents; avoid random flicker that has no relation to the audio.",
    `Avoid repeating recent generated scenes: ${recentAiScenes}.`,
    "Make the scene responsive to the provided audio variables where available.",
    "Keep it performant for real-time preview and LED output.",
    args.sceneType === "glsl"
      ? "Use WebGL 1 compatible GLSL. Output only helper functions and void mainImage; do not declare uniforms or precision. Use iBpm, iBeat, iBeatPhase, iBeatCount, constant iFft indices like iFft[0]/iFft[16], and fftAt(float) for variable FFT access. Never emit iFft[i], iFft[idx], or iFft[int(x)]. Keep loops literal-bounded and avoid nested loops when possible."
      : "Use the audio object/globals for beat pulses, bass/mid/treble movement, and tempo-aware animation.",
  ].join("\n");
}

function addGenreHint(prompt: string, audio: AudioAnalysis): string {
  return `${prompt}\n\nDetected genre: ${audio.genre}.\nEssentia mood scores: ${formatMoodPredictions(audio.moodPredictions)}.`;
}

function sceneTypeLabel(type: SceneType): string {
  return type === "threejs" ? "Three" : type.toUpperCase();
}

function formatTime(s: number): string {
  if (!isFinite(s) || s < 0) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}
