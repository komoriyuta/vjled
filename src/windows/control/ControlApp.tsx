import { useEffect, useRef, useCallback, useState } from "react";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { open } from "@tauri-apps/plugin-dialog";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { useVJStore } from "../../stores/vjStore";
import { useLedStore } from "../../stores/ledStore";
import { useAiStore } from "../../stores/aiStore";
import { useEngine } from "../../hooks/useEngine";
import type { Scene, SceneType, BusLabel } from "../../types";
import { emitVJState, listenVJStateRequest } from "../../events/vjEvents";
import { sendLedFrame } from "../../led/pixelExtractor";
import Editor from "@monaco-editor/react";
import LedPanel from "../../components/LedPanel";

const BG = "#090b10";
const SURFACE = "#10141d";
const SURFACE2 = "#171d28";
const SURFACE3 = "#202838";
const ACCENT = "#22d3ee";
const ACCENT2 = "#fb7185";
const TEXT = "#eef2ff";
const TEXT2 = "#94a3b8";
const BORDER = "#283244";
const OK = "#34d399";

const typeColors: Record<SceneType, string> = {
  glsl: "#ef4444",
  p5: "#38bdf8",
  threejs: "#22c55e",
  video: "#f59e0b",
};

type RightTab = "project" | "output" | "ai" | "led";

function formatTime(s: number): string {
  if (!isFinite(s) || s < 0) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

export default function ControlApp() {
  const {
    scenes, busA, busB, crossfade, isPlaying,
    selectedSceneId,
    addScene, removeScene, updateSceneCode,
    setBusA, setBusB, setCrossfade,
    cutToA, cutToB, fadeToA, fadeToB,
    setPlaying, selectScene,
  } = useVJStore();

  const loadProject = useVJStore((s) => s.loadProject);
  const ledLoadProject = useLedStore((s) => s.loadProject);
  const ledConfig = useLedStore((s) => s.config);
  const ledPoints = useLedStore((s) => s.calibrationPoints);

  const outputPreviewRef = useRef<HTMLDivElement>(null);
  const busACanvasRef = useRef<HTMLCanvasElement>(null);
  const busBCanvasRef = useRef<HTMLCanvasElement>(null);
  const selectedCanvasRef = useRef<HTMLCanvasElement>(null);
  const ledFrameRef = useRef(0);
  const [outputDecorated, setOutputDecorated] = useState(false);
  const [rightTab, setRightTab] = useState<RightTab>("output");

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
  });

  const selectedScene = scenes.find((s) => s.id === selectedSceneId) ?? null;
  const busAScene = scenes.find((s) => s.id === busA);
  const busBScene = scenes.find((s) => s.id === busB);
  const monacoLang = selectedScene?.type === "glsl" ? "cpp" : "javascript";

  const handleSave = useCallback(async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: "Project", extensions: ["vjled.json"] }],
        defaultPath: "project.vjled.json",
      });
      if (!selected) return;
      const state = useVJStore.getState();
      const led = useLedStore.getState();
      await invoke("project_save", {
        path: selected as string,
        data: {
          version: 1,
          vj: {
            scenes: state.scenes,
            busA: state.busA,
            busB: state.busB,
            crossfade: state.crossfade,
            isPlaying: state.isPlaying,
            selectedSceneId: state.selectedSceneId,
          },
          led: {
            config: led.config,
            calibrationPoints: led.calibrationPoints,
          },
        },
      });
    } catch (e) {
      console.error("Save failed:", e);
    }
  }, []);

  const handleLoad = useCallback(async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: "Project", extensions: ["vjled.json", "json"] }],
      });
      if (!selected) return;
      const project = await invoke<{ version: number; vj: unknown; led?: { config: unknown; calibrationPoints: unknown } }>("project_load", { path: selected as string });
      if (project.vj) loadProject(project.vj as any);
      if (project.led) {
        ledLoadProject(
          (project.led as any).config ?? useLedStore.getState().config,
          (project.led as any).calibrationPoints ?? [],
        );
      }
    } catch (e) {
      console.error("Load failed:", e);
    }
  }, [loadProject, ledLoadProject]);

  const handleAiGenerate = useCallback(async (sceneType: SceneType, prompt: string) => {
    try {
      const code = await aiGenerate(sceneType, prompt);
      addScene(sceneType);
      const state = useVJStore.getState();
      const newScene = state.scenes[state.scenes.length - 1];
      if (newScene) {
        updateSceneCode(newScene.id, code);
        selectScene(newScene.id);
      }
    } catch {}
  }, [aiGenerate, addScene, updateSceneCode, selectScene]);

  const handleAiEdit = useCallback(async (prompt: string) => {
    if (!selectedScene) return;
    try {
      const code = await aiGenerate(selectedScene.type, prompt, selectedScene.code);
      updateSceneCode(selectedScene.id, code);
    } catch {}
  }, [aiGenerate, selectedScene, updateSceneCode]);

  const openLedMapping = useCallback(async () => {
    const existing = await WebviewWindow.getByLabel("led-mapping");
    if (existing) {
      await existing.setFocus();
      return;
    }
    const win = new WebviewWindow("led-mapping", {
      url: "/led-mapping.html",
      title: "VJLED - LED Mapping",
      width: 1280,
      height: 720,
      decorations: true,
      resizable: true,
    });
    win.once("tauri://error", (e) => console.error("LED Mapping window error:", e));
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
  }, [ledConfig.enabled, ledPoints, ledConfig]);

  useEffect(() => {
    const publishState = () => {
      const state = useVJStore.getState();
      emitVJState({
        scenes: state.scenes,
        busA: state.busA,
        busB: state.busB,
        crossfade: state.crossfade,
        isPlaying: state.isPlaying,
        selectedSceneId: state.selectedSceneId,
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

  const handleCodeChange = useCallback(
    (value: string | undefined) => {
      if (selectedSceneId && value !== undefined) {
        updateSceneCode(selectedSceneId, value);
      }
    },
    [selectedSceneId, updateSceneCode],
  );

  function assignScene(sceneId: string, bus: BusLabel) {
    if (bus === "A") setBusA(sceneId);
    else setBusB(sceneId);
  }

  async function toggleOutputDecorations() {
    try {
      const appWindow = await WebviewWindow.getByLabel("output");
      if (!appWindow) return;
      const current = await appWindow.isDecorated();
      await appWindow.setDecorations(!current);
      setOutputDecorated(!current);
    } catch (e) {
      console.error("Failed to toggle decorations:", e);
    }
  }

  async function pickVideoFile() {
    if (!selectedSceneId) return;
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: "Video", extensions: ["mp4", "webm", "mov", "avi", "mkv", "ogv"] }],
      });
      if (selected) {
        updateSceneCode(selectedSceneId, convertFileSrc(selected as string));
      }
    } catch {}
  }

  const canvasStyle: React.CSSProperties = {
    maxWidth: "100%",
    maxHeight: "100%",
    objectFit: "contain",
    display: "block",
    borderRadius: 8,
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "220px minmax(420px, 1fr) 300px", height: "100vh", overflow: "hidden", background: BG, color: TEXT, fontFamily: "Avenir Next, ui-sans-serif, system-ui, sans-serif", fontSize: 13 }}>
      <aside style={{ borderRight: `1px solid ${BORDER}`, display: "flex", flexDirection: "column", minHeight: 0, background: SURFACE }}>
        <PanelHeader title="Scenes" subtitle={`${scenes.length} sources`} />
        <div style={{ flex: 1, overflowY: "auto", padding: 8 }}>
          {scenes.map((scene) => (
            <SceneItem
              key={scene.id}
              scene={scene}
              selected={selectedSceneId === scene.id}
              onA={busA === scene.id}
              onB={busB === scene.id}
              onSelect={() => selectScene(scene.id)}
              onDelete={() => removeScene(scene.id)}
              onAssign={(bus) => assignScene(scene.id, bus)}
            />
          ))}
          {scenes.length === 0 && (
            <EmptyState title="No scenes" body="Create GLSL, p5, Three.js, or Video sources from the bottom bar." />
          )}
        </div>
        <div style={{ padding: 8, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, borderTop: `1px solid ${BORDER}` }}>
          {(Object.keys(typeColors) as SceneType[]).map((type) => (
            <button key={type} onClick={() => addScene(type)} style={{ ...buttonBase, background: typeColors[type], borderColor: typeColors[type], color: "#fff" }}>
              + {type === "threejs" ? "Three" : type.toUpperCase()}
            </button>
          ))}
        </div>
      </aside>

      <main style={{ display: "grid", gridTemplateRows: "minmax(230px, 42vh) 118px 82px minmax(180px, 1fr)", minWidth: 0, minHeight: 0, overflow: "hidden" }}>
        <section style={{ padding: 12, minHeight: 0 }}>
          <PreviewFrame title="Program Output" meta={outputMeta(busAScene, busBScene, crossfade)} tone={ACCENT}>
            <div ref={outputPreviewRef} style={{ width: "100%", height: "100%", minHeight: 0, display: "flex", alignItems: "center", justifyContent: "center" }} />
          </PreviewFrame>
        </section>

        <section style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, padding: "0 12px 10px", minHeight: 0 }}>
          <PreviewFrame title="Bus A" meta={busAScene?.name ?? "empty"} tone={ACCENT}>
            <canvas ref={busACanvasRef} width={480} height={270} style={canvasStyle} />
          </PreviewFrame>
          <PreviewFrame title="Bus B" meta={busBScene?.name ?? "empty"} tone={ACCENT2}>
            <canvas ref={busBCanvasRef} width={480} height={270} style={canvasStyle} />
          </PreviewFrame>
          <PreviewFrame title="Selected" meta={selectedScene?.name ?? "none"} tone={selectedScene ? typeColors[selectedScene.type] : TEXT2}>
            <canvas ref={selectedCanvasRef} width={480} height={270} style={canvasStyle} />
          </PreviewFrame>
        </section>

        <section style={{ padding: "0 12px 10px" }}>
          <div style={{ height: "100%", background: SURFACE, border: `1px solid ${BORDER}`, borderRadius: 12, padding: 12, display: "grid", gridTemplateColumns: "auto 1fr auto", gap: 12, alignItems: "center" }}>
            <div style={{ display: "flex", gap: 6 }}>
              <VJButton onClick={cutToA}>CUT A</VJButton>
              <VJButton onClick={fadeToA}>FADE A</VJButton>
            </div>
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", color: TEXT2, fontWeight: 800, fontSize: 10, letterSpacing: 1, textTransform: "uppercase", marginBottom: 5 }}>
                <span style={{ color: ACCENT }}>A</span>
                <span>Crossfade {(crossfade * 100).toFixed(0)}%</span>
                <span style={{ color: ACCENT2 }}>B</span>
              </div>
              <input type="range" min={0} max={1} step={0.005} value={crossfade} onChange={(e) => setCrossfade(parseFloat(e.target.value))} style={{ width: "100%", accentColor: ACCENT }} />
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <VJButton onClick={fadeToB}>FADE B</VJButton>
              <VJButton onClick={cutToB}>CUT B</VJButton>
              <VJButton onClick={() => setPlaying(!isPlaying)} accent={isPlaying}>{isPlaying ? "PAUSE" : "PLAY"}</VJButton>
            </div>
          </div>
        </section>

        <section style={{ padding: "0 12px 12px", display: "flex", flexDirection: "column", minHeight: 0, overflow: "hidden" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
            <SectionTitle title={selectedScene ? `Edit ${selectedScene.name}` : "Editor"} />
            {selectedScene && <span style={{ color: typeColors[selectedScene.type], fontSize: 10, fontWeight: 800, textTransform: "uppercase" }}>{selectedScene.type}</span>}
          </div>
          <div style={{ flex: 1, borderRadius: 12, overflow: "hidden", border: `1px solid ${BORDER}`, minHeight: 0 }}>
            {selectedScene ? (
              selectedScene.type === "video" ? (
                <VideoEditor scene={selectedScene} onPick={pickVideoFile} sendCommand={sendCommand} getVideoInfo={getVideoInfo} />
              ) : (
                <Editor
                  height="100%"
                  language={monacoLang}
                  theme="vs-dark"
                  value={selectedScene.code}
                  onChange={handleCodeChange}
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
              )
            ) : (
              <EmptyState title="Select a scene" body="The selected source preview and editor will appear here." dark />
            )}
          </div>
        </section>
      </main>

      <aside style={{ borderLeft: `1px solid ${BORDER}`, display: "flex", flexDirection: "column", minHeight: 0, background: SURFACE }}>
        <div style={{ padding: 10, borderBottom: `1px solid ${BORDER}` }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
            {(["project", "output", "ai", "led"] as RightTab[]).map((tab) => (
              <button key={tab} onClick={() => setRightTab(tab)} style={{ ...buttonBase, background: rightTab === tab ? ACCENT : SURFACE2, borderColor: rightTab === tab ? ACCENT : BORDER, color: rightTab === tab ? "#001018" : TEXT2 }}>
                {tab.toUpperCase()}
              </button>
            ))}
          </div>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
          {rightTab === "project" && <ProjectPanel onSave={handleSave} onLoad={handleLoad} scenes={scenes} selectedScene={selectedScene} />}
          {rightTab === "output" && (
            <OutputPanel
              busAScene={busAScene}
              busBScene={busBScene}
              crossfade={crossfade}
              isPlaying={isPlaying}
              outputDecorated={outputDecorated}
              onToggleDecorations={toggleOutputDecorations}
              onOpenLedMapping={openLedMapping}
            />
          )}
          {rightTab === "ai" && (
            <AiPanel
              generating={aiGenerating}
              error={aiError}
              onGenerate={handleAiGenerate}
              onEdit={selectedScene ? handleAiEdit : undefined}
              config={aiConfig}
              onConfigChange={aiSetConfig}
              selectedScene={selectedScene}
            />
          )}
          {rightTab === "led" && (
            <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
              <div style={{ padding: 10, borderBottom: `1px solid ${BORDER}`, background: SURFACE2 }}>
                <SectionTitle title="LED Projection" />
                <p style={helpText}>Single-camera mapping is used here. Python's second source camera is intentionally replaced by the VJ program output canvas.</p>
                <button onClick={openLedMapping} style={{ ...buttonBase, width: "100%", marginTop: 8, background: SURFACE3, color: TEXT }}>
                  Open Mapping Window
                </button>
              </div>
              <div style={{ flex: 1, minHeight: 0 }}>
                <LedPanel />
              </div>
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}

function outputMeta(a: Scene | undefined, b: Scene | undefined, crossfade: number): string {
  if (!a && !b) return "no buses assigned";
  if (crossfade <= 0.01) return a?.name ?? "Bus A empty";
  if (crossfade >= 0.99) return b?.name ?? "Bus B empty";
  return `${a?.name ?? "empty"} + ${b?.name ?? "empty"}`;
}

function PanelHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div style={{ padding: 12, borderBottom: `1px solid ${BORDER}` }}>
      <div style={{ fontWeight: 900, letterSpacing: 1.5, textTransform: "uppercase", fontSize: 12 }}>{title}</div>
      {subtitle && <div style={{ marginTop: 3, color: TEXT2, fontSize: 11 }}>{subtitle}</div>}
    </div>
  );
}

function SectionTitle({ title }: { title: string }) {
  return <div style={{ color: TEXT, fontWeight: 900, fontSize: 11, textTransform: "uppercase", letterSpacing: 1.2 }}>{title}</div>;
}

function EmptyState({ title, body, dark }: { title: string; body: string; dark?: boolean }) {
  return (
    <div style={{ height: "100%", minHeight: 90, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center", padding: 14, background: dark ? "#1e1e1e" : "transparent" }}>
      <div style={{ color: TEXT, fontWeight: 800, fontSize: 12 }}>{title}</div>
      <div style={{ color: TEXT2, fontSize: 11, marginTop: 4, lineHeight: 1.4 }}>{body}</div>
    </div>
  );
}

function SceneItem({ scene, selected, onA, onB, onSelect, onDelete, onAssign }: {
  scene: Scene;
  selected: boolean;
  onA: boolean;
  onB: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onAssign: (bus: BusLabel) => void;
}) {
  return (
    <div onClick={onSelect} style={{ padding: 9, marginBottom: 7, borderRadius: 12, cursor: "pointer", background: selected ? SURFACE3 : SURFACE2, border: `1px solid ${selected ? typeColors[scene.type] : BORDER}` }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ width: 8, height: 8, borderRadius: 999, background: typeColors[scene.type], flexShrink: 0 }} />
        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 800 }}>{scene.name}</span>
        <button onClick={(e) => { e.stopPropagation(); onDelete(); }} style={{ ...iconButton, color: TEXT2 }} title="Delete">x</button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginTop: 8 }}>
        <BusButton label="A" active={onA} color={ACCENT} onClick={(e) => { e.stopPropagation(); onAssign("A"); }} />
        <BusButton label="B" active={onB} color={ACCENT2} onClick={(e) => { e.stopPropagation(); onAssign("B"); }} />
      </div>
    </div>
  );
}

function PreviewFrame({ title, meta, tone, children }: { title: string; meta: string; tone: string; children: React.ReactNode }) {
  return (
    <div style={{ height: "100%", background: SURFACE, border: `1px solid ${BORDER}`, borderRadius: 14, padding: 8, display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, height: 20, marginBottom: 6 }}>
        <span style={{ width: 6, height: 6, borderRadius: 999, background: tone }} />
        <span style={{ color: TEXT, fontWeight: 900, fontSize: 10, textTransform: "uppercase", letterSpacing: 1 }}>{title}</span>
        <span style={{ color: TEXT2, fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{meta}</span>
      </div>
      <div style={{ flex: 1, minHeight: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "#000", borderRadius: 10, overflow: "hidden" }}>
        {children}
      </div>
    </div>
  );
}

function ProjectPanel({ onSave, onLoad, scenes, selectedScene }: { onSave: () => void; onLoad: () => void; scenes: Scene[]; selectedScene: Scene | null }) {
  return (
    <div style={panelBody}>
      <SectionTitle title="Project" />
      <p style={helpText}>Save/load now lives outside previews. Project data includes VJ buses, scenes, LED config, and calibration points.</p>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <button onClick={onSave} style={{ ...buttonBase, background: ACCENT, borderColor: ACCENT, color: "#001018" }}>Save</button>
        <button onClick={onLoad} style={{ ...buttonBase, background: SURFACE3, color: TEXT }}>Load</button>
      </div>
      <InfoGrid rows={[
        ["Scenes", String(scenes.length)],
        ["Selected", selectedScene?.name ?? "None"],
        ["Type", selectedScene?.type ?? "-"],
      ]} />
    </div>
  );
}

function OutputPanel({ busAScene, busBScene, crossfade, isPlaying, outputDecorated, onToggleDecorations, onOpenLedMapping }: {
  busAScene: Scene | undefined;
  busBScene: Scene | undefined;
  crossfade: number;
  isPlaying: boolean;
  outputDecorated: boolean;
  onToggleDecorations: () => void;
  onOpenLedMapping: () => void;
}) {
  return (
    <div style={panelBody}>
      <SectionTitle title="Output Window" />
      <InfoGrid rows={[
        ["Status", isPlaying ? "Playing" : "Paused"],
        ["Bus A", busAScene?.name ?? "Empty"],
        ["Bus B", busBScene?.name ?? "Empty"],
        ["Mix", `${(crossfade * 100).toFixed(0)}% B`],
        ["Title bar", outputDecorated ? "Visible" : "Hidden"],
      ]} />
      <button onClick={onToggleDecorations} style={{ ...buttonBase, width: "100%", background: SURFACE3, color: TEXT }}>
        {outputDecorated ? "Hide Output Title Bar" : "Show Output Title Bar"}
      </button>
      <button onClick={onOpenLedMapping} style={{ ...buttonBase, width: "100%", background: SURFACE3, color: TEXT }}>
        Open LED Mapping
      </button>
      <div style={{ padding: 10, borderRadius: 10, border: `1px solid ${BORDER}`, background: "#0c111a" }}>
        <SectionTitle title="Python parity" />
        <p style={helpText}>UDP packet flow, brightness/gain curve, project calibration data, and auto calibration match the Python design. Person detection and two-camera floor/source mapping are not implemented in this UI yet; the VJ output replaces the source camera by design.</p>
      </div>
    </div>
  );
}

function AiPanel({ generating, error, onGenerate, onEdit, config, onConfigChange, selectedScene }: {
  generating: boolean;
  error: string | null;
  onGenerate: (type: SceneType, prompt: string) => void;
  onEdit?: (prompt: string) => void;
  config: { baseUrl: string; apiKey: string; model: string };
  onConfigChange: (c: Partial<{ baseUrl: string; apiKey: string; model: string }>) => void;
  selectedScene: Scene | null;
}) {
  const [prompt, setPrompt] = useState("");
  const [selectedType, setSelectedType] = useState<SceneType>("glsl");
  const [showSettings, setShowSettings] = useState(false);

  return (
    <div style={panelBody}>
      <SectionTitle title="AI Generate" />
      <p style={helpText}>Generate a new source or edit the selected scene without mixing AI controls into the scene list.</p>
      <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
        {(["glsl", "p5", "threejs"] as SceneType[]).map((type) => (
          <button key={type} onClick={() => setSelectedType(type)} style={{ ...buttonBase, background: selectedType === type ? typeColors[type] : SURFACE2, borderColor: selectedType === type ? typeColors[type] : BORDER, color: selectedType === type ? "#fff" : TEXT2 }}>
            {type === "threejs" ? "Three" : type.toUpperCase()}
          </button>
        ))}
      </div>
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="Describe the visual effect..."
        rows={6}
        style={{ ...inputStyle, resize: "vertical", fontFamily: "inherit" }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && prompt.trim() && !generating) {
            e.preventDefault();
            onGenerate(selectedType, prompt.trim());
          }
        }}
      />
      <button disabled={generating || !prompt.trim() || !config.apiKey} onClick={() => onGenerate(selectedType, prompt.trim())} style={primaryButton(generating || !prompt.trim() || !config.apiKey)}>
        {generating ? "Generating..." : "Generate New Scene"}
      </button>
      <button disabled={!onEdit || generating || !prompt.trim() || !config.apiKey} onClick={() => onEdit?.(prompt.trim())} style={secondaryButton(!onEdit || generating || !prompt.trim() || !config.apiKey)}>
        {selectedScene ? `Edit ${selectedScene.name}` : "Select Scene To Edit"}
      </button>
      <button onClick={() => setShowSettings(!showSettings)} style={{ ...buttonBase, background: "transparent", color: TEXT2, borderColor: BORDER }}>
        {showSettings ? "Hide API Settings" : "API Settings"}
      </button>
      {showSettings && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: 10, background: "#0c111a", border: `1px solid ${BORDER}`, borderRadius: 10 }}>
          <LabeledInput label="Base URL" value={config.baseUrl} onChange={(value) => onConfigChange({ baseUrl: value })} placeholder="https://api.openai.com/v1" />
          <LabeledInput label="API Key" type="password" value={config.apiKey} onChange={(value) => onConfigChange({ apiKey: value })} placeholder="sk-..." />
          <LabeledInput label="Model" value={config.model} onChange={(value) => onConfigChange({ model: value })} placeholder="gpt-4o" />
        </div>
      )}
      {error && <div style={{ padding: 8, background: "#3a1515", borderRadius: 8, fontSize: 11, color: "#fca5a5", maxHeight: 80, overflow: "auto" }}>{error}</div>}
    </div>
  );
}

function VideoEditor({ scene, onPick, sendCommand, getVideoInfo }: {
  scene: Scene;
  onPick: () => void;
  sendCommand: (id: string, action: string, value: unknown) => void;
  getVideoInfo: (id: string) => { currentTime: number; duration: number; playing: boolean; loop: boolean; loopStart: number; loopEnd: number } | null;
}) {
  const [playing, setPlaying] = useState(false);
  const [loop, setLoop] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [loopStart, setLoopStart] = useState(0);
  const [loopEnd, setLoopEnd] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      const info = getVideoInfo(scene.id);
      if (info) {
        setPlaying(info.playing);
        setCurrentTime(info.currentTime);
        setDuration(info.duration);
        setLoop(info.loop);
        setLoopStart(info.loopStart);
        setLoopEnd(info.loopEnd);
      }
    }, 50);
    return () => clearInterval(interval);
  }, [scene.id, getVideoInfo]);

  const hasVideo = !!scene.code;

  return (
    <div style={{ height: "100%", background: "#1e1e1e", display: "flex", flexDirection: "column", padding: 18, gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <span style={{ color: typeColors.video, fontSize: 20, flexShrink: 0 }}>&#9654;</span>
        <div style={{ flex: 1, minWidth: 0, color: hasVideo ? TEXT : TEXT2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {hasVideo ? scene.code : "No video selected"}
        </div>
        <button onClick={onPick} style={{ ...buttonBase, background: typeColors.video, borderColor: typeColors.video, color: "#fff" }}>
          {hasVideo ? "Change" : "Choose File"}
        </button>
      </div>
      {hasVideo && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button onClick={() => sendCommand(scene.id, playing ? "pause" : "play", undefined)} style={{ ...buttonBase, background: SURFACE3, color: TEXT }}>
              {playing ? "PAUSE" : "PLAY"}
            </button>
            <button onClick={() => sendCommand(scene.id, "loop", !loop)} style={{ ...buttonBase, background: loop ? ACCENT : SURFACE3, borderColor: loop ? ACCENT : BORDER, color: loop ? "#001018" : TEXT2 }}>
              {loop ? "LOOP" : "ONCE"}
            </button>
            <span style={{ color: TEXT2, fontSize: 12, marginLeft: "auto", fontVariantNumeric: "tabular-nums" }}>
              {formatTime(currentTime)} / {formatTime(duration)}
            </span>
          </div>
          <input type="range" min={0} max={duration || 0} step={0.01} value={currentTime} onChange={(e) => sendCommand(scene.id, "seek", parseFloat(e.target.value))} style={{ width: "100%", accentColor: typeColors.video }} />
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <button onClick={() => sendCommand(scene.id, "loopStart", currentTime)} style={secondaryButton(false)}>Set In</button>
            <span style={{ color: OK, fontVariantNumeric: "tabular-nums" }}>{formatTime(loopStart)}</span>
            <span style={{ color: TEXT2 }}>-</span>
            <span style={{ color: ACCENT2, fontVariantNumeric: "tabular-nums" }}>{formatTime(loopEnd)}</span>
            <button onClick={() => sendCommand(scene.id, "loopEnd", currentTime)} style={secondaryButton(false)}>Set Out</button>
            <button onClick={() => sendCommand(scene.id, "seek", loopStart)} style={secondaryButton(false)}>Go In</button>
            <button onClick={() => { sendCommand(scene.id, "loopStart", 0); sendCommand(scene.id, "loopEnd", -1); }} style={secondaryButton(false)}>Reset</button>
          </div>
        </div>
      )}
    </div>
  );
}

function BusButton({ label, active, color, onClick }: { label: string; active: boolean; color: string; onClick: (e: React.MouseEvent<HTMLButtonElement>) => void }) {
  return (
    <button onClick={onClick} style={{ ...buttonBase, padding: "4px 8px", background: active ? color : "transparent", borderColor: active ? color : BORDER, color: active ? "#001018" : TEXT2 }}>
      {label}
    </button>
  );
}

function VJButton({ onClick, children, accent }: { onClick: () => void; children: React.ReactNode; accent?: boolean }) {
  return (
    <button onClick={onClick} style={{ ...buttonBase, background: accent ? ACCENT : SURFACE3, borderColor: accent ? ACCENT : BORDER, color: accent ? "#001018" : TEXT }}>
      {children}
    </button>
  );
}

function InfoGrid({ rows }: { rows: [string, string][] }) {
  return (
    <div style={{ border: `1px solid ${BORDER}`, borderRadius: 10, overflow: "hidden" }}>
      {rows.map(([label, value]) => (
        <div key={label} style={{ display: "grid", gridTemplateColumns: "86px 1fr", gap: 8, padding: "8px 10px", borderBottom: `1px solid ${BORDER}`, background: SURFACE2 }}>
          <span style={{ color: TEXT2, fontSize: 10, fontWeight: 900, textTransform: "uppercase", letterSpacing: 0.8 }}>{label}</span>
          <span style={{ color: TEXT, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{value}</span>
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
    <label>
      <div style={{ fontSize: 10, fontWeight: 900, color: TEXT2, textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 4 }}>{label}</div>
      <input type={type} style={inputStyle} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
    </label>
  );
}

const buttonBase: React.CSSProperties = {
  border: `1px solid ${BORDER}`,
  borderRadius: 8,
  padding: "6px 10px",
  background: SURFACE2,
  color: TEXT,
  cursor: "pointer",
  fontSize: 10,
  fontWeight: 900,
  letterSpacing: 0.4,
  textTransform: "uppercase",
};

const iconButton: React.CSSProperties = {
  border: "none",
  background: "transparent",
  cursor: "pointer",
  fontSize: 13,
  padding: "0 2px",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  background: "#0c111a",
  border: `1px solid ${BORDER}`,
  borderRadius: 8,
  color: TEXT,
  padding: "8px 9px",
  fontSize: 12,
  boxSizing: "border-box",
};

const panelBody: React.CSSProperties = {
  height: "100%",
  boxSizing: "border-box",
  overflowY: "auto",
  padding: 12,
  display: "flex",
  flexDirection: "column",
  gap: 12,
};

const helpText: React.CSSProperties = {
  color: TEXT2,
  fontSize: 11,
  lineHeight: 1.5,
  margin: 0,
};

function primaryButton(disabled: boolean): React.CSSProperties {
  return {
    ...buttonBase,
    width: "100%",
    background: disabled ? SURFACE3 : ACCENT,
    borderColor: disabled ? BORDER : ACCENT,
    color: disabled ? TEXT2 : "#001018",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.55 : 1,
  };
}

function secondaryButton(disabled: boolean): React.CSSProperties {
  return {
    ...buttonBase,
    background: SURFACE3,
    color: disabled ? TEXT2 : TEXT,
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.55 : 1,
  };
}
