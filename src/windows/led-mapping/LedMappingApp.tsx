import { useEffect, useRef, useState, useCallback } from "react";
import { useLedStore } from "../../stores/ledStore";
import {
  ledInitSimple,
  ledLoadLayout,
  ledFill,
  ledAllOff,
  ledSetPixel,
  calibrationSetBaseline,
  calibrationDetectLed,
  calibrationReset,
} from "../../led/commands";
import { attachCameraStream, listCalibrationCameras, prepareCameraWindow, startCalibrationCamera, type CameraDevice } from "../../led/camera";
import { rgbaFromCanvas } from "../../led/pixelExtractor";
import type { CalibrationPoint } from "../../types";

const BG = "#111119";
const PANEL = "#1a1a28";
const ACCENT = "#7c5cfc";
const TEXT = "#e0e0e8";
const TEXT2 = "#888899";
const BORDER = "#2a2a3a";
const HANDLE_R = 8;

type Vec2 = [number, number];
type SideTab = "setup" | "map" | "calibrate" | "test";

function computeHomography(src: Vec2[], dst: Vec2[]): number[] | null {
  const [sx0, sy0] = src[0], [sx1, sy1] = src[1], [sx2, sy2] = src[2], [sx3, sy3] = src[3];
  const [dx0, dy0] = dst[0], [dx1, dy1] = dst[1], [dx2, dy2] = dst[2], [dx3, dy3] = dst[3];

  const A = [
    [sx0, sy0, 1, 0, 0, 0, -dx0*sx0, -dx0*sy0],
    [0, 0, 0, sx0, sy0, 1, -dy0*sx0, -dy0*sy0],
    [sx1, sy1, 1, 0, 0, 0, -dx1*sx1, -dx1*sy1],
    [0, 0, 0, sx1, sy1, 1, -dy1*sx1, -dy1*sy1],
    [sx2, sy2, 1, 0, 0, 0, -dx2*sx2, -dx2*sy2],
    [0, 0, 0, sx2, sy2, 1, -dy2*sx2, -dy2*sy2],
    [sx3, sy3, 1, 0, 0, 0, -dx3*sx3, -dx3*sy3],
    [0, 0, 0, sx3, sy3, 1, -dy3*sx3, -dy3*sy3],
  ];
  const b = [dx0, dy0, dx1, dy1, dx2, dy2, dx3, dy3];

  const n = 8;
  for (let col = 0; col < n; col++) {
    let maxRow = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(A[row][col]) > Math.abs(A[maxRow][col])) maxRow = row;
    }
    [A[col], A[maxRow]] = [A[maxRow], A[col]];
    [b[col], b[maxRow]] = [b[maxRow], b[col]];
    if (Math.abs(A[col][col]) < 1e-10) return null;
    const pivot = A[col][col];
    for (let j = col; j < n; j++) A[col][j] /= pivot;
    b[col] /= pivot;
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const f = A[row][col];
      for (let j = col; j < n; j++) A[row][j] -= f * A[col][j];
      b[row] -= f * b[col];
    }
  }

  return [...b, 1];
}

function applyHomography(H: number[], x: number, y: number): Vec2 {
  const w = H[6] * x + H[7] * y + H[8];
  return [
    (H[0] * x + H[1] * y + H[2]) / w,
    (H[3] * x + H[4] * y + H[5]) / w,
  ];
}

function mapCameraToVideo(
  camPoints: Vec2[],
  camLedPositions: CalibrationPoint[],
): CalibrationPoint[] {
  const videoCorners: Vec2[] = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const H = computeHomography(camPoints, videoCorners);
  if (!H) return [];

  return camLedPositions.map((p) => {
    const [vx, vy] = applyHomography(H, p.x, p.y);
    return { lanternId: p.lanternId, x: Math.max(0, Math.min(1, vx)), y: Math.max(0, Math.min(1, vy)) };
  });
}

export default function LedMappingApp() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const cameraStream = useLedStore((s) => s.cameraStream);
  const config = useLedStore((s) => s.config);
  const layoutInfo = useLedStore((s) => s.layoutInfo);
  const connected = useLedStore((s) => s.connected);
  const calibrationPoints = useLedStore((s) => s.calibrationPoints);
  const setCameraStream = useLedStore((s) => s.setCameraStream);
  const setCalibrationPoints = useLedStore((s) => s.setCalibrationPoints);
  const setConfig = useLedStore((s) => s.setConfig);
  const setLayoutInfo = useLedStore((s) => s.setLayoutInfo);
  const setConnected = useLedStore((s) => s.setConnected);
  const setCalibrating = useLedStore((s) => s.setCalibrating);
  const setCalibrationProgress = useLedStore((s) => s.setCalibrationProgress);
  const resetCalibration = useLedStore((s) => s.resetCalibration);

  const [handles, setHandles] = useState<Vec2[]>([
    [0.15, 0.15], [0.85, 0.15], [0.85, 0.85], [0.15, 0.85],
  ]);
  const [dragging, setDragging] = useState<number | null>(null);
  const [rawCamPoints, setRawCamPoints] = useState<CalibrationPoint[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sideTab, setSideTab] = useState<SideTab>("setup");
  const [cameras, setCameras] = useState<CameraDevice[]>([]);
  const [cameraStatus, setCameraStatus] = useState("Camera stopped");
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    prepareCameraWindow();
  }, []);

  useEffect(() => {
    if (videoRef.current && cameraStream) {
      attachCameraStream(videoRef.current, cameraStream)
        .then((status) => setCameraStatus(status))
        .catch((e) => setError(`Video playback: ${String(e)}`));
    }
  }, [cameraStream]);

  useEffect(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !cameraStream) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let frame = 0;
    const draw = () => {
      const width = video.videoWidth;
      const height = video.videoHeight;
      if (width > 0 && height > 0) {
        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width;
          canvas.height = height;
        }
        ctx.drawImage(video, 0, 0, width, height);
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);

    return () => cancelAnimationFrame(frame);
  }, [cameraStream]);

  const startCamera = useCallback(async () => {
    try {
      setError(null);
      const stream = await startCalibrationCamera(config.cameraDeviceId);
      setCameraStream(stream);
      const track = stream.getVideoTracks()[0];
      setCameraStatus(track?.label || "Camera stream opened");
      const devices = await listCalibrationCameras();
      setCameras(devices);
    } catch (e) {
      setError(`Camera: ${String(e)}`);
    }
  }, [config.cameraDeviceId, setCameraStream]);

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

  useEffect(() => {
    if (sideTab === "setup") refreshCameras();
  }, [sideTab, refreshCameras]);

  const stopCamera = useCallback(() => {
    if (cameraStream) {
      cameraStream.getTracks().forEach((t) => t.stop());
      setCameraStream(null);
      setCameraStatus("Camera stopped");
    }
  }, [cameraStream, setCameraStream]);

  const handleConnect = useCallback(async () => {
    setError(null);
    try {
      if (config.layoutPath) {
        const info = await ledLoadLayout(config.layoutPath);
        setLayoutInfo(info);
      } else {
        const info = await ledInitSimple(config.broadcastIp, config.port, config.deviceId, config.pixelCount);
        setLayoutInfo(info);
      }
      setConnected(true);
    } catch (e) {
      setError(String(e));
      setConnected(false);
    }
  }, [config, setLayoutInfo, setConnected]);

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const captureFrame = useCallback((): { data: number[]; width: number; height: number } | null => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return null;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    if (video.videoWidth > 0 && video.videoHeight > 0) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    }
    return rgbaFromCanvas(canvas);
  }, []);

  const runCalibration = useCallback(async () => {
    if (!connected || !layoutInfo) {
      setError("Connect LED first");
      return;
    }
    setCalibrating(true);
    resetCalibration();
    setRawCamPoints([]);
    setError(null);

    try {
      await calibrationReset();
      await ledAllOff();
      await sleep(500);

      const baseline = captureFrame();
      if (!baseline) { setError("No camera frame"); setCalibrating(false); return; }
      await calibrationSetBaseline(baseline.data, baseline.width, baseline.height);

      const total = layoutInfo.total_pixels;
      const camPts: CalibrationPoint[] = [];

      for (let i = 0; i < total; i++) {
        setCalibrationProgress((i + 1) / total);
        let detected: [number, number] | null = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          await ledAllOff();
          await sleep(100);
          await ledSetPixel(i, 255, 255, 255);
          await sleep(300);
          const lit = captureFrame();
          if (!lit) continue;
          detected = await calibrationDetectLed(lit.data, lit.width, lit.height);
          if (detected) break;
        }
        if (detected) {
          camPts.push({ lanternId: i, x: detected[0], y: detected[1] });
        }
      }

      setRawCamPoints(camPts);
      const mapped = mapCameraToVideo(handles, camPts);
      setCalibrationPoints(mapped);
      await ledAllOff();
    } catch (e) {
      setError(`Calibration: ${String(e)}`);
    } finally {
      setCalibrating(false);
    }
  }, [connected, layoutInfo, captureFrame, handles, setCalibrating, setCalibrationProgress, setCalibrationPoints, resetCalibration]);

  const remapPoints = useCallback(() => {
    if (rawCamPoints.length === 0) return;
    const mapped = mapCameraToVideo(handles, rawCamPoints);
    setCalibrationPoints(mapped);
  }, [handles, rawCamPoints, setCalibrationPoints]);

  useEffect(() => { remapPoints(); }, [handles, remapPoints]);

  useEffect(() => {
    const video = videoRef.current;
    const overlay = overlayRef.current;
    const container = containerRef.current;
    if (!video || !overlay || !container) return;

    const ctx = overlay.getContext("2d");
    if (!ctx) return;

    let animFrame = 0;
    const draw = () => {
      const rect = container.getBoundingClientRect();
      overlay.width = rect.width;
      overlay.height = rect.height;
      ctx.clearRect(0, 0, overlay.width, overlay.height);

      const w = overlay.width;
      const h = overlay.height;

      if (handles.length === 4) {
        ctx.beginPath();
        ctx.moveTo(handles[0][0] * w, handles[0][1] * h);
        for (let i = 1; i < 4; i++) ctx.lineTo(handles[i][0] * w, handles[i][1] * h);
        ctx.closePath();
        ctx.strokeStyle = "rgba(124, 92, 252, 0.7)";
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.fillStyle = "rgba(124, 92, 252, 0.08)";
        ctx.fill();
      }

      for (let i = 0; i < handles.length; i++) {
        const [hx, hy] = handles[i];
        ctx.beginPath();
        ctx.arc(hx * w, hy * h, HANDLE_R, 0, Math.PI * 2);
        ctx.fillStyle = dragging === i ? "#fff" : ACCENT;
        ctx.fill();
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.fillStyle = "#fff";
        ctx.font = "10px sans-serif";
        ctx.fillText(`${i + 1}`, hx * w + HANDLE_R + 4, hy * h + 4);
      }

      for (const pt of rawCamPoints) {
        ctx.beginPath();
        ctx.arc(pt.x * w, pt.y * h, 4, 0, Math.PI * 2);
        ctx.fillStyle = "#2ecc71";
        ctx.fill();
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      animFrame = requestAnimationFrame(draw);
    };
    animFrame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(animFrame);
  }, [handles, dragging, rawCamPoints]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    const rect = overlayRef.current?.getBoundingClientRect();
    if (!rect) return;
    const mx = (e.clientX - rect.left) / rect.width;
    const my = (e.clientY - rect.top) / rect.height;
    for (let i = 0; i < handles.length; i++) {
      const dx = mx - handles[i][0];
      const dy = my - handles[i][1];
      if (Math.sqrt(dx * dx + dy * dy) < 0.03) {
        setDragging(i);
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        return;
      }
    }
  }, [handles]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (dragging === null) return;
    const rect = overlayRef.current?.getBoundingClientRect();
    if (!rect) return;
    const mx = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const my = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
    setHandles((prev) => {
      const next = [...prev] as Vec2[];
      next[dragging] = [mx, my];
      return next;
    });
  }, [dragging]);

  const onPointerUp = useCallback(() => { setDragging(null); }, []);

  const inputStyle: React.CSSProperties = {
    width: "100%",
    background: "#0d0d15",
    border: `1px solid ${BORDER}`,
    borderRadius: 3,
    color: TEXT,
    padding: "3px 6px",
    fontSize: 11,
    boxSizing: "border-box",
  };

  return (
    <div style={{ display: "flex", height: "100vh", background: BG, color: TEXT, fontFamily: "-apple-system, system-ui, sans-serif", fontSize: 12 }}>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", position: "relative" }} ref={containerRef}>
        {cameraStream ? (
          <>
            <video ref={videoRef} autoPlay playsInline muted style={{ position: "absolute", width: 1, height: 1, opacity: 0, pointerEvents: "none" }} />
            <canvas ref={canvasRef} style={{ width: "100%", height: "100%", objectFit: "contain", background: "#000", display: "block" }} />
            <canvas ref={overlayRef} style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", cursor: dragging !== null ? "grabbing" : "default" }} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} />
          </>
        ) : (
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: TEXT2 }}>
            Start camera to begin mapping
          </div>
        )}
      </div>

      <div style={{ width: 260, borderLeft: `1px solid ${BORDER}`, display: "flex", flexDirection: "column", flexShrink: 0, overflow: "hidden" }}>
        <div style={{ fontWeight: 700, fontSize: 11, textTransform: "uppercase", letterSpacing: 1, color: ACCENT }}>
          <div style={{ padding: 8, borderBottom: `1px solid ${BORDER}` }}>LED Calibration</div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4, padding: 8, borderBottom: `1px solid ${BORDER}` }}>
          {(["setup", "map", "calibrate", "test"] as SideTab[]).map((tab) => (
            <button key={tab} onClick={() => setSideTab(tab)} style={{ background: sideTab === tab ? ACCENT : PANEL, border: `1px solid ${sideTab === tab ? ACCENT : BORDER}`, color: sideTab === tab ? "#fff" : TEXT2, borderRadius: 4, padding: "5px 8px", fontSize: 10, fontWeight: 700, cursor: "pointer", textTransform: "capitalize" }}>
              {tab}
            </button>
          ))}
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 8, display: "flex", flexDirection: "column", gap: 8 }}>
          {sideTab === "setup" && (
            <>
              <div>
                <div style={{ fontSize: 10, fontWeight: 700, color: TEXT2, textTransform: "uppercase", marginBottom: 3 }}>Camera</div>
                <div style={{ display: "flex", gap: 6 }}>
                  <button onClick={cameraStream ? stopCamera : startCamera} style={{ background: cameraStream ? "#e74c3c" : ACCENT, color: "#fff", border: "none", borderRadius: 4, padding: "6px 12px", fontSize: 11, fontWeight: 700, cursor: "pointer", flex: 1 }}>
                    {cameraStream ? "Stop Camera" : "Start Camera"}
                  </button>
                  <button onClick={refreshCameras} style={{ background: PANEL, border: `1px solid ${BORDER}`, color: TEXT, borderRadius: 4, padding: "6px 10px", fontSize: 10, cursor: "pointer" }}>
                    Scan
                  </button>
                </div>
                <select
                  value={config.cameraDeviceId ?? ""}
                  onChange={(e) => setConfig({ cameraDeviceId: e.target.value || null })}
                  style={{ ...inputStyle, marginTop: 6 }}
                >
                  <option value="">Default camera</option>
                  {cameras.map((camera) => (
                    <option key={camera.deviceId} value={camera.deviceId}>{camera.label}</option>
                  ))}
                </select>
                <div style={{ marginTop: 4, fontSize: 10, color: TEXT2, lineHeight: 1.4 }}>{cameraStatus}</div>
              </div>

              <div>
                <div style={{ fontSize: 10, fontWeight: 700, color: TEXT2, textTransform: "uppercase", marginBottom: 3 }}>Target IP</div>
                <input style={inputStyle} value={config.broadcastIp} onChange={(e) => setConfig({ broadcastIp: e.target.value })} />
              </div>

              <div style={{ display: "flex", gap: 6 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: TEXT2, textTransform: "uppercase", marginBottom: 3 }}>Port</div>
                  <input style={inputStyle} type="number" value={config.port} onChange={(e) => setConfig({ port: parseInt(e.target.value) || 7777 })} />
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: TEXT2, textTransform: "uppercase", marginBottom: 3 }}>Pixels</div>
                  <input style={inputStyle} type="number" value={config.pixelCount} onChange={(e) => setConfig({ pixelCount: parseInt(e.target.value) || 25 })} />
                </div>
              </div>

              <button onClick={handleConnect} style={{ background: connected ? "#2ecc71" : ACCENT, color: "#fff", border: "none", borderRadius: 4, padding: "6px 12px", fontSize: 11, fontWeight: 700, cursor: "pointer", width: "100%" }}>
                {connected ? "Reconnect LED" : "Connect LED"}
              </button>
            </>
          )}

          {sideTab === "map" && (
            <>
              <div style={{ fontSize: 10, color: TEXT2, lineHeight: 1.4 }}>
                Drag the 4 numbered corners on the camera view to outline the physical area used by the VJ output.
              </div>
              {handles.map((h, i) => (
                <div key={i} style={{ display: "grid", gridTemplateColumns: "20px 1fr 1fr", gap: 4, alignItems: "center", fontSize: 10, color: TEXT2 }}>
                  <span>{i + 1}</span>
                  <input style={inputStyle} type="number" min={0} max={1} step={0.01} value={h[0].toFixed(2)} onChange={(e) => {
                    const x = Math.max(0, Math.min(1, parseFloat(e.target.value) || 0));
                    setHandles((prev) => prev.map((p, idx) => idx === i ? [x, p[1]] : p));
                  }} />
                  <input style={inputStyle} type="number" min={0} max={1} step={0.01} value={h[1].toFixed(2)} onChange={(e) => {
                    const y = Math.max(0, Math.min(1, parseFloat(e.target.value) || 0));
                    setHandles((prev) => prev.map((p, idx) => idx === i ? [p[0], y] : p));
                  }} />
                </div>
              ))}
            </>
          )}

          {sideTab === "calibrate" && (
            <>
              <button
                onClick={runCalibration}
                disabled={!connected || !cameraStream}
                style={{
                  width: "100%",
                  background: ACCENT,
                  color: "#fff",
                  border: "none",
                  borderRadius: 4,
                  padding: "7px 12px",
                  fontSize: 11,
                  fontWeight: 700,
                  cursor: !connected || !cameraStream ? "not-allowed" : "pointer",
                  opacity: !connected || !cameraStream ? 0.5 : 1,
                }}
              >
                Auto Calibrate
              </button>
              <div style={{ background: "#0d0d15", borderRadius: 4, padding: 6, fontSize: 10 }}>
                <div>Camera raw: {rawCamPoints.length} points</div>
                <div>Mapped output: {calibrationPoints.length} points</div>
                <div>LED output: {config.enabled ? "Enabled" : "Disabled"}</div>
              </div>
              <button onClick={() => setConfig({ enabled: !config.enabled })} style={{ background: config.enabled ? "#2ecc71" : PANEL, border: `1px solid ${config.enabled ? "#2ecc71" : BORDER}`, color: config.enabled ? "#fff" : TEXT2, borderRadius: 4, padding: "6px 12px", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
                {config.enabled ? "Disable LED Output" : "Enable LED Output"}
              </button>
            </>
          )}

          {sideTab === "test" && (
            <>
              <div>
                <div style={{ fontSize: 10, fontWeight: 700, color: TEXT2, textTransform: "uppercase", marginBottom: 4 }}>Brightness</div>
                <input type="range" min={0.05} max={1} step={0.01} value={config.brightness} onChange={(e) => setConfig({ brightness: parseFloat(e.target.value) })} style={{ width: "100%" }} />
                <span style={{ fontSize: 10, color: TEXT2 }}>{(config.brightness * 100).toFixed(0)}%</span>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                <button onClick={async () => { try { await ledFill(255, 0, 0); } catch (e) { setError(String(e)); } }} style={{ background: "#e74c3c", border: "none", borderRadius: 4, padding: "6px 8px", fontSize: 10, cursor: "pointer", color: "#fff" }}>Red</button>
                <button onClick={async () => { try { await ledFill(0, 255, 0); } catch (e) { setError(String(e)); } }} style={{ background: "#2ecc71", border: "none", borderRadius: 4, padding: "6px 8px", fontSize: 10, cursor: "pointer", color: "#fff" }}>Green</button>
                <button onClick={async () => { try { await ledFill(0, 0, 255); } catch (e) { setError(String(e)); } }} style={{ background: "#3498db", border: "none", borderRadius: 4, padding: "6px 8px", fontSize: 10, cursor: "pointer", color: "#fff" }}>Blue</button>
                <button onClick={async () => { try { await ledAllOff(); } catch (e) { setError(String(e)); } }} style={{ background: PANEL, border: `1px solid ${BORDER}`, borderRadius: 4, padding: "6px 8px", fontSize: 10, cursor: "pointer", color: TEXT2 }}>Off</button>
              </div>
            </>
          )}

          {error && (
            <div style={{ background: "#3a1515", borderRadius: 4, padding: 6, fontSize: 10, color: "#ff6b6b", lineHeight: 1.35 }}>
              {error}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
