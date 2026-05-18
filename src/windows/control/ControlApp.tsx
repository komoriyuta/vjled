import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Editor from "@monaco-editor/react";
import { useAiStore } from "../../stores/aiStore";
import { useLedStore } from "../../stores/ledStore";
import { emptyAudioAnalysis, useVJStore } from "../../stores/vjStore";
import { emitVJState, listenVJStateRequest } from "../../events/vjEvents";
import { sendLedFrame } from "../../led/pixelExtractor";
import { listAudioDevices, type RustAudioDevice, useAudioAnalysis } from "../../hooks/useAudioAnalysis";
import { useEngine } from "../../hooks/useEngine";
import { createProjectData, parseProjectData } from "../../project";
import type { AudioAnalysis, BusLabel, MixMode, MixSettings, Scene, SceneKeySettings, SceneType, VideoSync } from "../../types";
import LedPanel from "../../components/LedPanel";
import {
  chooseProjectLoadPath,
  chooseProjectSavePath,
  chooseVideoPath,
  loadProjectFile,
  openLedMappingWindow,
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
  maxScenes: number;
}

interface AudioMood {
  label: string;
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

const defaultAutoVJ: AutoVJSettings = {
  enabled: false,
  sceneType: "auto",
  intervalBars: 4,
  maxScenes: 12,
};

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

const blendModes: MixMode[] = ["crossfade", "additive", "screen", "multiply", "overlay", "softLight", "difference", "lighten", "darken"];
const transitionModes: MixMode[] = ["wipeLeft", "wipeRight", "wipeUp", "wipeDown", "circle", "diamond", "dissolve", "luma", "ripple", "glitch", "rgbSplit"];

const defaultSceneKey: SceneKeySettings = {
  enabled: false,
  threshold: 0.08,
  softness: 0.08,
  spill: 0.2,
};

export default function ControlApp() {
  const {
    scenes,
    busA,
    busB,
    crossfade,
    mix,
    isPlaying,
    selectedSceneId,
    addScene,
    removeScene,
    updateSceneCode,
    setBusA,
    setBusB,
    setCrossfade,
    setMixSettings,
    setSceneKey,
    renameScene,
    cutToA,
    cutToB,
    fadeToA,
    fadeToB,
    setPlaying,
    selectScene,
    setVideoSync,
  } = useVJStore();

  useAudioAnalysis();

  const loadProject = useVJStore((s) => s.loadProject);
  const audio = useVJStore((s) => s.audio);
  const setAudioEnabled = useVJStore((s) => s.setAudioEnabled);
  const setAudioDevice = useVJStore((s) => s.setAudioDevice);
  const ledLoadProject = useLedStore((s) => s.loadProject);
  const ledConfig = useLedStore((s) => s.config);
  const ledPoints = useLedStore((s) => s.calibrationPoints);

  const outputPreviewRef = useRef<HTMLDivElement>(null);
  const busACanvasRef = useRef<HTMLCanvasElement>(null);
  const busBCanvasRef = useRef<HTMLCanvasElement>(null);
  const selectedCanvasRef = useRef<HTMLCanvasElement>(null);
  const contextSelectedCanvasRef = useRef<HTMLCanvasElement>(null);
  const codeSelectedCanvasRef = useRef<HTMLCanvasElement>(null);
  const scenePreviewCanvasesRef = useRef<Map<string, HTMLCanvasElement | null>>(new Map());
  const ledFrameRef = useRef(0);
  const selectedPreviewRefs = useMemo(
    () => [contextSelectedCanvasRef, codeSelectedCanvasRef],
    [],
  );

  const [workspace, setWorkspace] = useState<Workspace>("perform");
  const [outputDecorated, setOutputDecorated] = useState(false);
  const [ledMappingStatus, setLedMappingStatus] = useState("Calibration window not open");
  const [autoVJ, setAutoVJ] = useState<AutoVJSettings>(defaultAutoVJ);
  const [autoStatus, setAutoStatus] = useState<AutoVJStatus>(() => ({
    mood: analyzeAudioMood(emptyAudioAnalysis),
    lastAction: "Idle",
    nextTrigger: "Waiting for audio",
  }));
  const autoBusyRef = useRef(false);
  const autoLastBeatRef = useRef(0);
  const autoLastWallTriggerRef = useRef(0);
  const autoPrimedRef = useRef(false);

  const aiConfig = useAiStore((s) => s.config);
  const aiGenerating = useAiStore((s) => s.generating);
  const aiError = useAiStore((s) => s.error);
  const aiSetConfig = useAiStore((s) => s.setConfig);
  const aiGenerate = useAiStore((s) => s.generate);

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
      ledLoadProject(project.led.config, project.led.calibrationPoints, project.led.layoutInfo);
      if (project.ai) aiSetConfig(project.ai);
    } catch (e) {
      console.error("Load failed:", e);
    }
  }, [loadProject, ledLoadProject, aiSetConfig]);

  const handleAiGenerate = useCallback(
    async (sceneType: SceneType, prompt: string) => {
      try {
        const code = await aiGenerate(sceneType, prompt);
        addScene(sceneType);
        const currentScenes = useVJStore.getState().scenes;
        const nextScene = currentScenes[currentScenes.length - 1];
        if (nextScene) {
          updateSceneCode(nextScene.id, code);
          selectScene(nextScene.id);
        }
      } catch {}
    },
    [aiGenerate, addScene, updateSceneCode, selectScene],
  );

  const handleAiEdit = useCallback(
    async (prompt: string) => {
      if (!selectedScene) return;
      try {
        const code = await aiGenerate(selectedScene.type, prompt, selectedScene.code);
        updateSceneCode(selectedScene.id, code);
      } catch {}
    },
    [aiGenerate, selectedScene, updateSceneCode],
  );

  const updateAutoVJ = useCallback((patch: Partial<AutoVJSettings>) => {
    setAutoVJ((current) => {
      const next = { ...current, ...patch };
      if (patch.enabled !== undefined || patch.intervalBars !== undefined || patch.sceneType !== undefined) {
        autoLastBeatRef.current = 0;
        autoLastWallTriggerRef.current = 0;
        autoPrimedRef.current = false;
      }
      return next;
    });
  }, []);

  const runAutoVJCycle = useCallback(
    async (reason: string, mood: AudioMood) => {
      if (autoBusyRef.current || !autoVJ.enabled || !aiConfig.apiKey) return;
      autoBusyRef.current = true;
      setAutoStatus((s) => ({
        ...s,
        mood,
        lastAction: `Generating ${mood.label.toLowerCase()} scene`,
      }));

      try {
        const type = pickAutoSceneType(autoVJ.sceneType, mood);
        const mode = pickAutoMixMode(mood);
        const prompt = buildAutoPrompt({
          mood,
          audio: useVJStore.getState().audio,
          reason,
          sceneType: type,
          currentScenes: useVJStore.getState().scenes,
        });
        const code = await aiGenerate(type, prompt);

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
          fadeToB();
        } else {
          setBusA(generated.id);
          fadeToA();
        }

        const after = useVJStore.getState();
        const extraScenes = after.scenes.filter((scene) => scene.name.startsWith("AI "));
        if (extraScenes.length > autoVJ.maxScenes) {
          const protectedIds = new Set([after.busA, after.busB, generated.id]);
          const removable = extraScenes.find((scene) => !protectedIds.has(scene.id));
          if (removable) removeScene(removable.id);
        }

        setAutoStatus({
          mood,
          lastAction: `${reason}: ${mixLabels[mode]} to ${generatedName}`,
          nextTrigger: `After ${autoVJ.intervalBars} bars`,
        });
      } catch (e) {
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
    [addScene, aiConfig.apiKey, aiGenerate, autoVJ.enabled, autoVJ.intervalBars, autoVJ.maxScenes, autoVJ.sceneType, fadeToA, fadeToB, removeScene, renameScene, selectScene, setBusA, setBusB, setMixSettings, updateSceneCode],
  );

  useEffect(() => {
    const mood = analyzeAudioMood(audio);
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
  }, [aiConfig.apiKey, audio, autoVJ.enabled]);

  useEffect(() => {
    if (!autoVJ.enabled || !aiConfig.apiKey || !audio.enabled) return;

    const mood = analyzeAudioMood(audio);
    const intervalBeats = Math.max(1, autoVJ.intervalBars * 4);
    const hasBeatClock = audio.beatCount > 0 && audio.bpm > 0;

    if (hasBeatClock) {
      if (autoLastBeatRef.current === 0) {
        autoLastBeatRef.current = audio.beatCount;
      }
      const elapsedBeats = audio.beatCount - autoLastBeatRef.current;
      setAutoStatus((s) => ({
        ...s,
        mood,
        nextTrigger: `${Math.max(0, intervalBeats - elapsedBeats)} beats`,
      }));
      if (!autoPrimedRef.current && audio.beat) {
        autoPrimedRef.current = true;
        autoLastBeatRef.current = audio.beatCount;
        void runAutoVJCycle("initial mood lock", mood);
        return;
      }
      if (audio.beat && elapsedBeats >= intervalBeats) {
        autoLastBeatRef.current = audio.beatCount;
        void runAutoVJCycle(`${autoVJ.intervalBars} bar refresh`, mood);
      }
      return;
    }

    const now = performance.now();
    const wallInterval = Math.max(12_000, autoVJ.intervalBars * 8_000);
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
      void runAutoVJCycle(reason, mood);
    }
  }, [aiConfig.apiKey, audio, autoVJ.enabled, autoVJ.intervalBars, runAutoVJCycle]);

  useEffect(() => {
    if (!autoVJ.enabled) {
      autoLastBeatRef.current = 0;
      autoLastWallTriggerRef.current = 0;
      autoPrimedRef.current = false;
    }
  }, [autoVJ.enabled]);

  const openLedMapping = useCallback(async () => {
    try {
      setLedMappingStatus("Opening calibration window...");
      const status = await openLedMappingWindow();
      setLedMappingStatus(status === "focused" ? "Calibration window focused" : "Calibration window open");
    } catch (e) {
      setLedMappingStatus(`Failed to open calibration window: ${String(e)}`);
    }
  }, []);

  useEffect(() => {
    if (!ledConfig.enabled || ledPoints.length === 0) return;
    let running = true;
    let lastSend = 0;
    const interval = 1000 / 30;

    const loop = () => {
      if (!running) return;
      const now = performance.now();
      if (now - lastSend >= interval) {
        lastSend = now;
        const canvas = outputPreviewRef.current?.querySelector("canvas") as HTMLCanvasElement | null;
        const ctx = canvas?.getContext("2d");
        if (canvas && ctx) {
          sendLedFrame(ctx, canvas.width, canvas.height, ledPoints, ledConfig);
        }
      }
      ledFrameRef.current = requestAnimationFrame(loop);
    };
    ledFrameRef.current = requestAnimationFrame(loop);

    return () => {
      running = false;
      cancelAnimationFrame(ledFrameRef.current);
    };
  }, [ledConfig.enabled, ledConfig, ledPoints]);

  useEffect(() => {
    const publishState = () => {
      const state = useVJStore.getState();
      emitVJState({
        scenes: state.scenes,
        busA: state.busA,
        busB: state.busB,
        crossfade: state.crossfade,
        mix: state.mix,
        isPlaying: state.isPlaying,
        selectedSceneId: state.selectedSceneId,
        audio: state.audio,
      });
    };

    const unsub = useVJStore.subscribe(publishState);
    const unlistenRequest = listenVJStateRequest(publishState);
    publishState();

    return () => {
      unsub();
      unlistenRequest.then((fn) => fn());
    };
  }, []);

  const assignScene = useCallback(
    (sceneId: string, bus: BusLabel) => {
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
      <TopBar isPlaying={isPlaying} audio={audio} onTogglePlay={() => setPlaying(!isPlaying)} />
      <div className="app-grid">
        <SideNav workspace={workspace} onChange={setWorkspace} />
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
          onSelectScene={selectScene}
          onScenePreviewRef={(sceneId, canvas) => {
            if (canvas) scenePreviewCanvasesRef.current.set(sceneId, canvas);
            else scenePreviewCanvasesRef.current.delete(sceneId);
          }}
        />
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
          ledMappingStatus={ledMappingStatus}
          aiConfig={aiConfig}
          aiGenerating={aiGenerating}
          aiError={aiError}
          autoVJ={autoVJ}
          autoStatus={autoStatus}
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
          onOpenLedMapping={openLedMapping}
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
    </div>
  );
}

function TopBar({ isPlaying, audio, onTogglePlay }: { isPlaying: boolean; audio: AudioAnalysis; onTogglePlay: () => void }) {
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand__mark">VJLED</span>
        <span className="brand__sub">CONTROL</span>
      </div>
      <div className="topbar__status">
        <span className="status-chip"><span className={`status-dot ${isPlaying ? "is-live" : ""}`} />{isPlaying ? "LIVE" : "PAUSED"}</span>
        <span className="status-chip">{audio.bpm ? `${audio.bpm.toFixed(1)} BPM` : "NO BPM"}</span>
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

function SceneLibrary({ scenes, selectedSceneId, busA, busB, onAddScene, onAssignScene, onDeleteScene, onScenePreviewRef, onSelectScene }: Omit<Parameters<typeof ContextPanel>[0], "workspace" | "selectedScene" | "selectedCanvasRef">) {
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
  ledMappingStatus: string;
  aiConfig: { baseUrl: string; apiKey: string; model: string };
  aiGenerating: boolean;
  aiError: string | null;
  autoVJ: AutoVJSettings;
  autoStatus: AutoVJStatus;
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
  onOpenLedMapping: () => void;
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
    <main className="main-workspace">
      <PerformanceStage {...props} />
      <FeaturePanel {...props} />
    </main>
  );
}

function PerformanceStage(props: {
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
  return (
    <section className="stage">
      <PreviewFrame title="Program Output" meta={outputMeta(props.busAScene, props.busBScene, props.crossfade, props.mix)} tone="var(--cyan)" program>
        <div ref={props.outputPreviewRef} className="render-mount" />
      </PreviewFrame>
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
    return <LedWorkspace onOpenLedMapping={props.onOpenLedMapping} ledMappingStatus={props.ledMappingStatus} />;
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
        <button className="button" onClick={onFadeA}>To A</button>
        <button className="button" onClick={onFadeB}>To B</button>
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

function SceneCard({ scene, selected, onA, onB, onSelect, onDelete, onAssign, onPreviewRef }: {
  scene: Scene;
  selected: boolean;
  onA: boolean;
  onB: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onAssign: (bus: BusLabel) => void;
  onPreviewRef: (canvas: HTMLCanvasElement | null) => void;
}) {
  return (
    <div className={`scene-card ${selected ? "is-selected" : ""}`} style={{ "--type": typeColors[scene.type] } as React.CSSProperties} onClick={onSelect} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onSelect(); }}>
      <div className="scene-card__preview">
        <canvas ref={onPreviewRef} width={192} height={108} />
      </div>
      <div className="scene-card__top">
        <span className="scene-card__led" />
        <span className="scene-card__name">{scene.name}</span>
        <span className="scene-card__badge">{scene.type}</span>
      </div>
      <div className="scene-card__actions">
        <button className={`button ${onA ? "is-active" : ""}`} style={{ "--active": "var(--cyan)" } as React.CSSProperties} onClick={(e) => { e.stopPropagation(); onAssign("A"); }}>A</button>
        <button className={`button ${onB ? "is-active" : ""}`} style={{ "--active": "var(--rose)" } as React.CSSProperties} onClick={(e) => { e.stopPropagation(); onAssign("B"); }}>B</button>
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

function OutputPanel({ busAScene, busBScene, crossfade, mix, isPlaying, outputDecorated, onToggleOutputDecorations, onOpenLedMapping, ledMappingStatus }: Parameters<typeof MainWorkspace>[0]) {
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
      <button className="button" onClick={onOpenLedMapping}>Open Calibration Window</button>
      <p className="help">{ledMappingStatus}</p>
    </aside>
  );
}

function AudioPanel({ audio, onToggle, onDevice }: { audio: AudioAnalysis; onToggle: (enabled: boolean) => void; onDevice: (deviceId: string, label?: string) => void }) {
  const [devices, setDevices] = useState<RustAudioDevice[]>([]);

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
      ]} />
      <div className="vu">
        {audio.fft.slice(0, 16).map((v, i) => (
          <div key={i} className="vu__bar" style={{ height: `${Math.max(3, v * 48)}px`, background: i < 5 ? "var(--green)" : i < 12 ? "var(--cyan)" : "var(--rose)" }} />
        ))}
      </div>
    </aside>
  );
}

function AiPanel({ generating, error, onGenerate, onEdit, config, onConfigChange, selectedScene, audio, autoVJ, autoStatus, onAutoVJChange }: {
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

function LedWorkspace({ onOpenLedMapping, ledMappingStatus }: { onOpenLedMapping: () => void; ledMappingStatus: string }) {
  return (
    <aside className="feature-panel led-feature">
      <SectionTitle>LED</SectionTitle>
      <button className="button" onClick={onOpenLedMapping}>Open Calibration Window</button>
      <p className="help">{ledMappingStatus}</p>
      <div className="led-panel-mount">
        <LedPanel />
      </div>
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
      <span>{value.toFixed(2)}</span>
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

function outputMeta(a: Scene | undefined, b: Scene | undefined, crossfade: number, mix: MixSettings): string {
  if (!a && !b) return "no buses assigned";
  if (crossfade <= 0.01) return a?.name ?? "Bus A empty";
  if (crossfade >= 0.99) return b?.name ?? "Bus B empty";
  return `${mixLabels[mix.mode]} ${a?.name ?? "empty"} -> ${b?.name ?? "empty"}`;
}

function bandAverage(values: number[], start: number, end: number): number {
  const slice = values.slice(start, end);
  if (slice.length === 0) return 0;
  return Math.max(0, Math.min(1, slice.reduce((sum, value) => sum + value, 0) / slice.length));
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
      energy: 0,
      bass: 0,
      mid: 0,
      treble: 0,
      palette: "dim monochrome with faint cyan accents",
      motion: "slow drifting",
      texture: "minimal particles and soft gradients",
    };
  }

  if (fastTempo && treble > 0.48 && bass < 0.44) {
    return {
      label: "Hyper Spark",
      energy,
      bass,
      mid,
      treble,
      palette: "white, laser cyan, acid green, and clipped pink",
      motion: "rapid micro-cuts, jittering streaks, and tight beat subdivisions",
      texture: "needle lines, pixel sparks, scanlines, and crystalline shards",
    };
  }
  if (energy > 0.72 && bass > 0.48) {
    return {
      label: "Peak Drive",
      energy,
      bass,
      mid,
      treble,
      palette: "hot magenta, electric cyan, and hard white flashes",
      motion: "hard beat-locked pulses with forward momentum",
      texture: "sharp geometry, tunnels, strobes, and impact rings",
    };
  }
  if (energy > 0.62 && mid > bass + 0.08 && mid > treble + 0.04) {
    return {
      label: "Vocal Heat",
      energy,
      bass,
      mid,
      treble,
      palette: "warm amber, saturated red, ivory, and deep violet",
      motion: "phrased waves, call-and-response pulses, and elastic silhouettes",
      texture: "ribbons, contour lines, glowing masks, and breathing halos",
    };
  }
  if (energy > 0.58 && brightness > 0.08) {
    return {
      label: "Bright Lift",
      energy,
      bass,
      mid,
      treble,
      palette: "aqua, lime, white, and saturated pink highlights",
      motion: "fast shimmering sweeps and rising arcs",
      texture: "thin lines, spark fields, prisms, and airy trails",
    };
  }
  if (energy > 0.54 && balancedSpectrum) {
    return {
      label: "Full Spectrum",
      energy,
      bass,
      mid,
      treble,
      palette: "full color bands, clean white accents, and saturated primaries",
      motion: "wide symmetrical expansion with layered beat pulses",
      texture: "spectrum grids, rotating panels, waveform ribbons, and kaleidoscope folds",
    };
  }
  if (bass > 0.42 && treble < 0.36) {
    return {
      label: "Dark Weight",
      energy,
      bass,
      mid,
      treble,
      palette: "deep red, sodium amber, black, and muted blue",
      motion: "heavy low-frequency breathing and slow pressure waves",
      texture: "molten blobs, low tunnels, shadows, and bass ripples",
    };
  }
  if (lowTempo && bass > 0.32 && energy < 0.56) {
    return {
      label: "Slow Pressure",
      energy,
      bass,
      mid,
      treble,
      palette: "black cherry, low amber, steel blue, and smoke gray",
      motion: "slow sub-heavy swells with long decays",
      texture: "viscous waves, compressed fog, large soft rings, and floor-level glow",
    };
  }
  if (treble > 0.42 && energy < 0.5) {
    return {
      label: "Glitter Air",
      energy,
      bass,
      mid,
      treble,
      palette: "pale cyan, silver, lavender, and sparse white",
      motion: "delicate floating shimmer with occasional sparkle bursts",
      texture: "dust, stars, thin filaments, rippled glass, and soft lens streaks",
    };
  }
  if (energy < 0.34) {
    return {
      label: "Ambient Drift",
      energy,
      bass,
      mid,
      treble,
      palette: "indigo, teal, silver, and soft violet",
      motion: "slow floating parallax and gentle phase shifts",
      texture: "mist, flowing contours, stars, and liquid gradients",
    };
  }
  if (bass > treble + 0.16) {
    return {
      label: "Bass Bounce",
      energy,
      bass,
      mid,
      treble,
      palette: "neon green, cyan, warm orange, and black",
      motion: "springy low-end bounces and rounded beat impacts",
      texture: "rubber shapes, blobs, circles, bass meters, and elastic ripples",
    };
  }
  if (mid > 0.34 && treble > 0.34 && bass < 0.34) {
    return {
      label: "Percussive Grid",
      energy,
      bass,
      mid,
      treble,
      palette: "cool gray, cyan, yellow hits, and red accents",
      motion: "snappy grid steps, syncopated flashes, and angular sweeps",
      texture: "tiles, dots, sequencer blocks, tick marks, and sliced panels",
    };
  }
  return {
    label: "Groove Pulse",
    energy,
    bass,
    mid,
    treble,
    palette: "cyan, coral, warm gold, and deep neutral backing",
    motion: "medium beat pulses with elastic lateral movement",
    texture: "layered waves, radial motifs, and rhythmic particles",
  };
}

function pickAutoSceneType(setting: AutoSceneType, mood: AudioMood): GenerativeSceneType {
  if (setting !== "auto") return setting;
  if (mood.label === "Peak Drive" || mood.label === "Dark Weight" || mood.label === "Hyper Spark" || mood.label === "Full Spectrum") return "glsl";
  if (mood.label === "Ambient Drift" || mood.label === "Slow Pressure") return "threejs";
  if (mood.label === "Vocal Heat" || mood.label === "Bass Bounce" || mood.label === "Percussive Grid") return "p5";
  return mood.treble > mood.bass ? "p5" : "glsl";
}

function pickAutoMixMode(mood: AudioMood): MixMode {
  if (mood.label === "Hyper Spark") return "rgbSplit";
  if (mood.label === "Peak Drive") return mood.treble > 0.5 ? "rgbSplit" : "glitch";
  if (mood.label === "Vocal Heat") return "overlay";
  if (mood.label === "Bright Lift") return "ripple";
  if (mood.label === "Full Spectrum") return "diamond";
  if (mood.label === "Dark Weight") return "luma";
  if (mood.label === "Slow Pressure") return "wipeUp";
  if (mood.label === "Glitter Air") return "screen";
  if (mood.label === "Ambient Drift") return "softLight";
  if (mood.label === "Bass Bounce") return "circle";
  if (mood.label === "Percussive Grid") return "wipeRight";
  return mood.bass > mood.treble ? "circle" : "dissolve";
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

  return [
    "Create a new live VJ scene for the currently playing music.",
    `Trigger reason: ${args.reason}.`,
    `Detected mood: ${args.mood.label}.`,
    `Audio features from the existing Aubio pipeline: BPM ${args.audio.bpm.toFixed(1)}, energy ${args.mood.energy.toFixed(2)}, bass ${args.mood.bass.toFixed(2)}, mid ${args.mood.mid.toFixed(2)}, treble ${args.mood.treble.toFixed(2)}.`,
    `Visual palette: ${args.mood.palette}.`,
    `Motion: ${args.mood.motion}.`,
    `Texture: ${args.mood.texture}.`,
    `Avoid repeating recent generated scenes: ${recentAiScenes}.`,
    "Make the scene responsive to the provided audio variables where available.",
    "Keep it performant for real-time preview and LED output.",
    args.sceneType === "glsl"
      ? "Use iBpm, iBeat, iBeatPhase, iBeatCount, and iFft[32] directly in the shader."
      : "Use the audio object/globals for beat pulses, bass/mid/treble movement, and tempo-aware animation.",
  ].join("\n");
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
