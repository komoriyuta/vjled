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

const BG = "#111119";
const PANEL = "#1a1a28";
const ACCENT = "#7c5cfc";
const ACCENT2 = "#fc5c7c";
const TEXT = "#e0e0e8";
const TEXT2 = "#888899";
const BORDER = "#2a2a3a";

const typeColors: Record<SceneType, string> = {
  glsl: "#e74c3c",
  p5: "#3498db",
  threejs: "#2ecc71",
  video: "#f39c12",
};

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
      const project = {
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
      };
      await invoke("project_save", { path: selected as string, data: project });
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
      if (project.vj) {
        loadProject(project.vj as any);
      }
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

  const outputPreviewRef = useRef<HTMLDivElement>(null);
  const busACanvasRef = useRef<HTMLCanvasElement>(null);
  const busBCanvasRef = useRef<HTMLCanvasElement>(null);
  const selectedCanvasRef = useRef<HTMLCanvasElement>(null);
  const [outputDecorated, setOutputDecorated] = useState(false);
  const [showLedPanel, setShowLedPanel] = useState(false);
  const [showAiPanel, setShowAiPanel] = useState(false);
  const [showAiSettings, setShowAiSettings] = useState(false);

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

  const ledFrameRef = useRef(0);

  const selectedScene = scenes.find((s) => s.id === selectedSceneId) ?? null;

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

  useEffect(() => {
    if (!ledConfig.enabled || ledPoints.length === 0) return;
    let running = true;
    let lastSend = 0;
    const LED_FPS = 30;
    const interval = 1000 / LED_FPS;

    const loop = () => {
      if (!running) return;
      const now = performance.now();
      if (now - lastSend >= interval) {
        lastSend = now;
        const container = outputPreviewRef.current;
        const canvas = container?.querySelector("canvas") as HTMLCanvasElement | null;
        if (canvas) {
          const ctx = canvas.getContext("2d");
          if (ctx) {
            sendLedFrame(ctx, canvas.width, canvas.height, ledPoints, ledConfig);
          }
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

    const unsub = useVJStore.subscribe((state) => {
      emitVJState({
        scenes: state.scenes,
        busA: state.busA,
        busB: state.busB,
        crossfade: state.crossfade,
        isPlaying: state.isPlaying,
        selectedSceneId: state.selectedSceneId,
      });
    });

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
        filters: [{
          name: "Video",
          extensions: ["mp4", "webm", "mov", "avi", "mkv", "ogv"],
        }],
      });
      if (selected) {
        const filePath = selected as string;
        const src = convertFileSrc(filePath);
        updateSceneCode(selectedSceneId, src);
      }
    } catch {}
  }

  const busAScene = scenes.find((s) => s.id === busA);
  const busBScene = scenes.find((s) => s.id === busB);

  const monacoLang = selectedScene?.type === "glsl" ? "cpp" : "javascript";

  const canvasStyle: React.CSSProperties = {
    maxWidth: "100%",
    maxHeight: "100%",
    objectFit: "contain",
    display: "block",
    borderRadius: 4,
  };

  return (
    <div style={{ display: "flex", height: "100vh", overflow: "hidden", background: BG, color: TEXT, fontFamily: "-apple-system, system-ui, sans-serif", fontSize: 13 }}>
      {/* LEFT: Scene Library */}
      <div style={{ width: 200, borderRight: `1px solid ${BORDER}`, display: "flex", flexDirection: "column", flexShrink: 0 }}>
        <div style={{ padding: "8px 10px 4px", fontWeight: 700, fontSize: 10, textTransform: "uppercase", letterSpacing: 1.5, color: TEXT2, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span>Scenes</span>
          <div style={{ display: "flex", gap: 4 }}>
            <button onClick={handleSave} style={{ background: "none", border: `1px solid ${BORDER}`, color: TEXT2, fontSize: 9, borderRadius: 3, padding: "1px 6px", cursor: "pointer" }}>Save</button>
            <button onClick={handleLoad} style={{ background: "none", border: `1px solid ${BORDER}`, color: TEXT2, fontSize: 9, borderRadius: 3, padding: "1px 6px", cursor: "pointer" }}>Load</button>
          </div>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "0 6px" }}>
          {scenes.map((s) => {
            const isOnA = busA === s.id;
            const isOnB = busB === s.id;
            const isSelected = selectedSceneId === s.id;
            return (
              <div
                key={s.id}
                onClick={() => selectScene(s.id)}
                style={{
                  padding: "6px 8px",
                  marginBottom: 2,
                  borderRadius: 6,
                  cursor: "pointer",
                  background: isSelected ? PANEL : "transparent",
                  border: isSelected ? `1px solid ${ACCENT}` : "1px solid transparent",
                  transition: "all 0.1s",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ width: 6, height: 6, borderRadius: "50%", background: typeColors[s.type], flexShrink: 0 }} />
                  <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.name}</span>
                  <button
                    onClick={(e) => { e.stopPropagation(); removeScene(s.id); }}
                    style={{ background: "none", border: "none", color: TEXT2, cursor: "pointer", fontSize: 11, padding: "0 2px" }}
                    title="Delete"
                  >
                    x
                  </button>
                </div>
                <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
                  <BusButton label="A" active={isOnA} color={ACCENT} onClick={() => assignScene(s.id, "A")} />
                  <BusButton label="B" active={isOnB} color={ACCENT2} onClick={() => assignScene(s.id, "B")} />
                </div>
              </div>
            );
          })}
        </div>
        <div style={{ padding: 6, display: "flex", gap: 4, flexWrap: "wrap", borderTop: `1px solid ${BORDER}` }}>
          {(Object.keys(typeColors) as SceneType[]).map((type) => (
            <button
              key={type}
              onClick={() => addScene(type)}
              style={{
                padding: "3px 7px",
                background: typeColors[type],
                color: "#fff",
                border: "none",
                borderRadius: 4,
                cursor: "pointer",
                fontSize: 10,
                fontWeight: 700,
              }}
            >
              +{type === "threejs" ? "Three" : type.toUpperCase()}
            </button>
          ))}
        </div>
        <div style={{ borderTop: `1px solid ${BORDER}`, padding: 6, flexShrink: 0 }}>
          <button
            onClick={() => setShowAiPanel(!showAiPanel)}
            style={{
              width: "100%",
              padding: "4px 8px",
              background: showAiPanel ? ACCENT : PANEL,
              border: `1px solid ${showAiPanel ? ACCENT : BORDER}`,
              color: showAiPanel ? "#fff" : TEXT2,
              borderRadius: 4,
              cursor: "pointer",
              fontSize: 10,
              fontWeight: 700,
              marginBottom: showAiPanel ? 6 : 0,
            }}
          >
            AI Generate
          </button>
          {showAiPanel && (
            <AiPromptArea
              generating={aiGenerating}
              error={aiError}
              onGenerate={handleAiGenerate}
              onEdit={selectedScene ? handleAiEdit : undefined}
              onSettings={() => setShowAiSettings(!showAiSettings)}
              showSettings={showAiSettings}
              config={aiConfig}
              onConfigChange={aiSetConfig}
            />
          )}
        </div>
      </div>

      {/* CENTER COLUMN */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>

        {/* Row 1: Bus A / Bus B previews */}
        <div style={{ display: "flex", gap: 8, padding: 8, height: 100, flexShrink: 0 }}>
          <PreviewCard label="BUS A" scene={busAScene} color={ACCENT}>
            <canvas ref={busACanvasRef} width={480} height={270} style={canvasStyle} />
          </PreviewCard>
          <PreviewCard label="BUS B" scene={busBScene} color={ACCENT2}>
            <canvas ref={busBCanvasRef} width={480} height={270} style={canvasStyle} />
          </PreviewCard>
        </div>

        {/* Row 2: Scene Preview / Output Preview */}
        <div style={{ display: "flex", gap: 8, padding: "0 8px", height: 120, flexShrink: 0 }}>
          <PreviewCard label="Scene" scene={selectedScene ?? undefined} color={TEXT}>
            <canvas ref={selectedCanvasRef} width={480} height={270} style={canvasStyle} />
          </PreviewCard>
          <PreviewCard label="Output" scene={undefined} color={TEXT} extra={
            <div style={{ display: "flex", gap: 4 }}>
              <button
                onClick={() => setShowLedPanel(!showLedPanel)}
                style={{
                  background: showLedPanel ? ACCENT : "none",
                  border: `1px solid ${showLedPanel ? ACCENT : BORDER}`,
                  color: showLedPanel ? "#fff" : TEXT2,
                  fontSize: 9,
                  borderRadius: 3,
                  padding: "1px 6px",
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                LED
              </button>
              <button
                onClick={toggleOutputDecorations}
                style={{
                  background: "none",
                  border: `1px solid ${BORDER}`,
                  color: TEXT2,
                  fontSize: 9,
                  borderRadius: 3,
                  padding: "1px 6px",
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                {outputDecorated ? "Hide Bar" : "Show Bar"}
              </button>
            </div>
          }>
            <div
              ref={outputPreviewRef}
              style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", minHeight: 0 }}
            />
          </PreviewCard>
        </div>

        {/* Row 3: Crossfader */}
        <div style={{ padding: "6px 8px", flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ color: ACCENT, fontWeight: 700, fontSize: 12 }}>A</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.005}
              value={crossfade}
              onChange={(e) => setCrossfade(parseFloat(e.target.value))}
              style={{ flex: 1, accentColor: ACCENT }}
            />
            <span style={{ color: ACCENT2, fontWeight: 700, fontSize: 12 }}>B</span>
          </div>
          <div style={{ display: "flex", gap: 4, marginTop: 4, justifyContent: "center" }}>
            <VJButton onClick={cutToA}>CUT A</VJButton>
            <VJButton onClick={cutToB}>CUT B</VJButton>
            <VJButton onClick={fadeToA}>FADE A</VJButton>
            <VJButton onClick={fadeToB}>FADE B</VJButton>
            <VJButton onClick={() => setPlaying(!isPlaying)} accent={isPlaying}>
              {isPlaying ? "PAUSE" : "PLAY"}
            </VJButton>
          </div>
        </div>

        {/* Row 4: Code Editor / Video Controls */}
        <div style={{ flex: 1, padding: "0 8px 8px", display: "flex", flexDirection: "column", minHeight: 0, overflow: "hidden" }}>
          <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 1, color: TEXT2, marginBottom: 4, fontWeight: 700, flexShrink: 0 }}>
            {selectedScene ? `Code: ${selectedScene.name} (${selectedScene.type})` : "Select a scene"}
          </div>
          <div style={{ flex: 1, borderRadius: 6, overflow: "hidden", border: `1px solid ${BORDER}`, minHeight: 0 }}>
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
                    padding: { top: 8 },
                  }}
                />
              )
            ) : (
              <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#1e1e1e", color: TEXT2 }}>
                Select a scene to edit code
              </div>
            )}
          </div>
        </div>
      </div>

      {/* RIGHT: LED Panel */}
      {showLedPanel && (
        <div style={{ width: 240, borderLeft: `1px solid ${BORDER}`, flexShrink: 0 }}>
          <LedPanel />
        </div>
      )}
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

  const togglePlay = () => {
    sendCommand(scene.id, playing ? "pause" : "play", undefined);
  };

  const toggleLoop = () => {
    sendCommand(scene.id, "loop", !loop);
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    sendCommand(scene.id, "seek", parseFloat(e.target.value));
  };

  const setInPoint = () => {
    sendCommand(scene.id, "loopStart", currentTime);
  };

  const setOutPoint = () => {
    sendCommand(scene.id, "loopEnd", currentTime);
  };

  const resetLoopPoints = () => {
    sendCommand(scene.id, "loopStart", 0);
    sendCommand(scene.id, "loopEnd", -1);
  };

  const seekToLoopStart = () => {
    sendCommand(scene.id, "seek", loopStart);
  };

  const hasVideo = !!scene.code;

  return (
    <div style={{ height: "100%", background: "#1e1e1e", display: "flex", flexDirection: "column", padding: 16, gap: 10 }}>
      {/* File section */}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ color: typeColors.video, fontSize: 20, flexShrink: 0 }}>&#9654;</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          {hasVideo ? (
            <div style={{ color: TEXT, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {scene.code}
            </div>
          ) : (
            <div style={{ color: TEXT2, fontSize: 12 }}>No video selected</div>
          )}
        </div>
        <button onClick={onPick} style={{ background: typeColors.video, color: "#fff", border: "none", borderRadius: 6, padding: "6px 16px", fontSize: 12, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" }}>
          {hasVideo ? "Change" : "Choose File"}
        </button>
      </div>

      {/* Controls */}
      {hasVideo && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {/* Transport */}
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <button onClick={togglePlay} style={{ background: PANEL, border: `1px solid ${BORDER}`, color: TEXT, borderRadius: 4, padding: "4px 14px", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
              {playing ? "\u275A\u275A" : "\u25B6"}
            </button>
            <button onClick={toggleLoop} style={{ background: loop ? ACCENT : PANEL, border: `1px solid ${loop ? ACCENT : BORDER}`, color: loop ? "#fff" : TEXT2, borderRadius: 4, padding: "4px 10px", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
              {loop ? "LOOP" : "ONCE"}
            </button>
            <span style={{ color: TEXT2, fontSize: 11, marginLeft: "auto", fontVariantNumeric: "tabular-nums" }}>
              {formatTime(currentTime)} / {formatTime(duration)}
            </span>
          </div>

          {/* Seek bar */}
          <input
            type="range"
            min={0}
            max={duration || 0}
            step={0.01}
            value={currentTime}
            onChange={handleSeek}
            style={{ width: "100%", accentColor: typeColors.video }}
          />

          {/* AB Loop controls */}
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ color: "#4ecdc4", fontSize: 10, fontWeight: 700 }}>A</span>
            <button onClick={setInPoint} style={{ background: PANEL, border: `1px solid ${BORDER}`, color: TEXT, borderRadius: 3, padding: "2px 8px", fontSize: 10, fontWeight: 700, cursor: "pointer" }}>
              Set In
            </button>
            <span style={{ color: "#4ecdc4", fontSize: 11, fontVariantNumeric: "tabular-nums", minWidth: 42 }}>
              {formatTime(loopStart)}
            </span>

            <span style={{ color: TEXT2, fontSize: 10, fontWeight: 700 }}>-</span>

            <span style={{ color: ACCENT2, fontSize: 11, fontVariantNumeric: "tabular-nums", minWidth: 42 }}>
              {formatTime(loopEnd)}
            </span>
            <button onClick={setOutPoint} style={{ background: PANEL, border: `1px solid ${BORDER}`, color: TEXT, borderRadius: 3, padding: "2px 8px", fontSize: 10, fontWeight: 700, cursor: "pointer" }}>
              Set Out
            </button>
            <span style={{ color: ACCENT2, fontSize: 10, fontWeight: 700 }}>B</span>

            <button onClick={seekToLoopStart} style={{ background: PANEL, border: `1px solid ${BORDER}`, color: TEXT2, borderRadius: 3, padding: "2px 6px", fontSize: 10, cursor: "pointer", marginLeft: 4 }}>
              Go A
            </button>
            <button onClick={resetLoopPoints} style={{ background: PANEL, border: `1px solid ${BORDER}`, color: TEXT2, borderRadius: 3, padding: "2px 6px", fontSize: 10, cursor: "pointer" }}>
              Reset
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function PreviewCard({ label, scene, color, children, extra }: { label: string; scene: Scene | undefined; color: string; children: React.ReactNode; extra?: React.ReactNode }) {
  return (
    <div style={{ flex: 1, background: PANEL, borderRadius: 6, padding: 6, display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4, height: 14, lineHeight: "14px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ color, fontWeight: 700, fontSize: 10, textTransform: "uppercase", letterSpacing: 1 }}>{label}</span>
          {scene && (
            <span style={{ color: TEXT2, fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 120 }}>
              {scene.name}
            </span>
          )}
        </div>
        {extra}
      </div>
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", background: "#000", borderRadius: 4, overflow: "hidden", minHeight: 0 }}>
        {children}
      </div>
    </div>
  );
}

function BusButton({ label, active, color, onClick }: { label: string; active: boolean; color: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "1px 8px",
        fontSize: 10,
        fontWeight: 700,
        borderRadius: 3,
        cursor: "pointer",
        border: active ? `1px solid ${color}` : `1px solid ${BORDER}`,
        background: active ? color : "transparent",
        color: active ? "#fff" : TEXT2,
        transition: "all 0.1s",
      }}
    >
      {label}
    </button>
  );
}

function VJButton({ onClick, children, accent }: { onClick: () => void; children: React.ReactNode; accent?: boolean }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "4px 12px",
        fontSize: 11,
        fontWeight: 700,
        borderRadius: 4,
        cursor: "pointer",
        border: `1px solid ${BORDER}`,
        background: accent ? ACCENT : PANEL,
        color: accent ? "#fff" : TEXT,
        transition: "all 0.1s",
      }}
    >
      {children}
    </button>
  );
}

function AiPromptArea({ generating, error, onGenerate, onEdit, onSettings, showSettings, config, onConfigChange }: {
  generating: boolean;
  error: string | null;
  onGenerate: (type: SceneType, prompt: string) => void;
  onEdit?: (prompt: string) => void;
  onSettings: () => void;
  showSettings: boolean;
  config: { baseUrl: string; apiKey: string; model: string };
  onConfigChange: (c: Partial<{ baseUrl: string; apiKey: string; model: string }>) => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [selectedType, setSelectedType] = useState<SceneType>("glsl");

  const inputStyle: React.CSSProperties = {
    width: "100%",
    background: "#0d0d15",
    border: `1px solid ${BORDER}`,
    borderRadius: 3,
    color: TEXT,
    padding: "4px 6px",
    fontSize: 11,
    boxSizing: "border-box",
  };

  const labelStyle: React.CSSProperties = {
    fontSize: 9,
    fontWeight: 700,
    color: TEXT2,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 2,
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
        {(["glsl", "p5", "threejs"] as SceneType[]).map((t) => (
          <button
            key={t}
            onClick={() => setSelectedType(t)}
            style={{
              padding: "2px 6px",
              background: selectedType === t ? typeColors[t] : "transparent",
              color: selectedType === t ? "#fff" : TEXT2,
              border: `1px solid ${selectedType === t ? typeColors[t] : BORDER}`,
              borderRadius: 3,
              cursor: "pointer",
              fontSize: 9,
              fontWeight: 700,
            }}
          >
            {t === "threejs" ? "Three" : t.toUpperCase()}
          </button>
        ))}
      </div>

      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="Describe the visual effect..."
        rows={2}
        style={{ ...inputStyle, resize: "vertical", fontFamily: "inherit" }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && prompt.trim() && !generating) {
            e.preventDefault();
            onGenerate(selectedType, prompt.trim());
          }
        }}
      />

      <div style={{ display: "flex", gap: 4 }}>
        <button
          disabled={generating || !prompt.trim() || !config.apiKey}
          onClick={() => onGenerate(selectedType, prompt.trim())}
          style={{
            flex: 1,
            padding: "3px 8px",
            background: generating ? TEXT2 : ACCENT,
            color: "#fff",
            border: "none",
            borderRadius: 3,
            cursor: generating || !prompt.trim() || !config.apiKey ? "not-allowed" : "pointer",
            fontSize: 10,
            fontWeight: 700,
            opacity: generating || !config.apiKey ? 0.5 : 1,
          }}
        >
          {generating ? "Generating..." : "Generate New"}
        </button>
        {onEdit && (
          <button
            disabled={generating || !prompt.trim() || !config.apiKey}
            onClick={() => onEdit(prompt.trim())}
            style={{
              flex: 1,
              padding: "3px 8px",
              background: PANEL,
              color: generating || !config.apiKey ? TEXT2 : TEXT,
              border: `1px solid ${BORDER}`,
              borderRadius: 3,
              cursor: generating || !prompt.trim() || !config.apiKey ? "not-allowed" : "pointer",
              fontSize: 10,
              fontWeight: 700,
              opacity: generating || !config.apiKey ? 0.5 : 1,
            }}
          >
            {generating ? "..." : "Edit Current"}
          </button>
        )}
      </div>

      <button onClick={onSettings} style={{ background: "none", border: "none", color: TEXT2, fontSize: 9, cursor: "pointer", textAlign: "left", padding: 0 }}>
        {showSettings ? "Hide Settings" : "API Settings"}
      </button>

      {showSettings && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4, background: "#0d0d15", borderRadius: 4, padding: 6 }}>
          <div>
            <div style={labelStyle}>Base URL</div>
            <input style={inputStyle} value={config.baseUrl} onChange={(e) => onConfigChange({ baseUrl: e.target.value })} placeholder="https://api.openai.com/v1" />
          </div>
          <div>
            <div style={labelStyle}>API Key</div>
            <input type="password" style={inputStyle} value={config.apiKey} onChange={(e) => onConfigChange({ apiKey: e.target.value })} placeholder="sk-..." />
          </div>
          <div>
            <div style={labelStyle}>Model</div>
            <input style={inputStyle} value={config.model} onChange={(e) => onConfigChange({ model: e.target.value })} placeholder="gpt-4o" />
          </div>
        </div>
      )}

      {error && (
        <div style={{ background: "#3a1515", borderRadius: 3, padding: 4, fontSize: 9, color: "#ff6b6b", maxHeight: 40, overflow: "auto" }}>
          {error}
        </div>
      )}
    </div>
  );
}
