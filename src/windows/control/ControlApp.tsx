import { useEffect, useRef, useCallback, useState } from "react";
import { emit } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { open } from "@tauri-apps/plugin-dialog";
import { useVJStore } from "../../stores/vjStore";
import { useEngine } from "../../hooks/useEngine";
import type { Scene, SceneType, BusLabel } from "../../types";
import Editor from "@monaco-editor/react";

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

export default function ControlApp() {
  const {
    scenes, busA, busB, crossfade, isPlaying,
    selectedSceneId,
    addScene, removeScene, updateSceneCode,
    setBusA, setBusB, setCrossfade,
    cutToA, cutToB, fadeToA, fadeToB,
    setPlaying, selectScene,
  } = useVJStore();

  const outputPreviewRef = useRef<HTMLDivElement>(null);
  const busACanvasRef = useRef<HTMLCanvasElement>(null);
  const busBCanvasRef = useRef<HTMLCanvasElement>(null);
  const selectedCanvasRef = useRef<HTMLCanvasElement>(null);
  const [outputDecorated, setOutputDecorated] = useState(false);

  useEngine({
    outputContainerRef: outputPreviewRef,
    preview: true,
    busAPreviewRef: busACanvasRef,
    busBPreviewRef: busBCanvasRef,
    selectedPreviewRef: selectedCanvasRef,
  });

  const selectedScene = scenes.find((s) => s.id === selectedSceneId) ?? null;

  useEffect(() => {
    const unsub = useVJStore.subscribe((state) => {
      emit("vj-state", {
        scenes: state.scenes,
        busA: state.busA,
        busB: state.busB,
        crossfade: state.crossfade,
        isPlaying: state.isPlaying,
        selectedSceneId: state.selectedSceneId,
      });
    });
    emit("vj-state", {
      scenes, busA, busB, crossfade, isPlaying, selectedSceneId,
    });
    return unsub;
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
        const path = typeof selected === "string" ? selected : selected;
        const filePath = path as string;
        const src = `file://${filePath}`;
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
        <div style={{ padding: "8px 10px 4px", fontWeight: 700, fontSize: 10, textTransform: "uppercase", letterSpacing: 1.5, color: TEXT2 }}>
          Scenes
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

        {/* Row 4: Code Editor / Video Picker */}
        <div style={{ flex: 1, padding: "0 8px 8px", display: "flex", flexDirection: "column", minHeight: 0, overflow: "hidden" }}>
          <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 1, color: TEXT2, marginBottom: 4, fontWeight: 700, flexShrink: 0, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>
              {selectedScene ? `Code: ${selectedScene.name} (${selectedScene.type})` : "Select a scene"}
            </span>
            {selectedScene?.type === "video" && (
              <button
                onClick={pickVideoFile}
                style={{
                  background: typeColors.video,
                  color: "#fff",
                  border: "none",
                  borderRadius: 4,
                  padding: "2px 10px",
                  fontSize: 10,
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                Choose File
              </button>
            )}
          </div>
          <div style={{ flex: 1, borderRadius: 6, overflow: "hidden", border: `1px solid ${BORDER}`, minHeight: 0 }}>
            {selectedScene ? (
              selectedScene.type === "video" ? (
                <VideoEditor scene={selectedScene} onPick={pickVideoFile} />
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
    </div>
  );
}

function VideoEditor({ scene, onPick }: { scene: Scene; onPick: () => void }) {
  return (
    <div style={{ height: "100%", background: "#1e1e1e", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, padding: 20 }}>
      <div style={{ color: typeColors.video, fontSize: 32 }}>&#9654;</div>
      <div style={{ color: TEXT2, fontSize: 13 }}>Video Scene</div>
      {scene.code ? (
        <div style={{ color: TEXT, fontSize: 12, maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", padding: "0 12px" }}>
          {scene.code}
        </div>
      ) : (
        <div style={{ color: TEXT2, fontSize: 12 }}>No video selected</div>
      )}
      <button
        onClick={onPick}
        style={{
          background: typeColors.video,
          color: "#fff",
          border: "none",
          borderRadius: 6,
          padding: "8px 24px",
          fontSize: 13,
          fontWeight: 700,
          cursor: "pointer",
        }}
      >
        Choose Video File
      </button>
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
