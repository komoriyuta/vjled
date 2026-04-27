import { useEffect, useRef, useState, useCallback } from "react";
import { useLedStore } from "../stores/ledStore";
import {
  ledInitSimple,
  ledLoadLayout,
  ledFill,
  ledAllOff,
  ledSetPixel,
  ledPing,
  calibrationSetBaseline,
  calibrationDetectLed,
  calibrationReset,
} from "../led/commands";
import { rgbaFromCanvas } from "../led/pixelExtractor";
import { open } from "@tauri-apps/plugin-dialog";
import type { CalibrationPoint } from "../types";

const BG = "#111119";
const PANEL = "#1a1a28";
const ACCENT = "#7c5cfc";
const TEXT = "#e0e0e8";
const TEXT2 = "#888899";
const BORDER = "#2a2a3a";

export default function LedPanel() {
  const {
    config, layoutInfo, calibrationPoints,
    calibrating, calibrationProgress, connected, cameraStream,
    setConfig, setLayoutInfo, setCalibrationPoints,
    setCalibrating, setCalibrationProgress, setConnected,
    setCameraStream, resetCalibration,
  } = useLedStore();

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"config" | "calibration">("config");

  useEffect(() => {
    if (videoRef.current && cameraStream) {
      videoRef.current.srcObject = cameraStream;
    }
  }, [cameraStream]);

  const handleConnect = useCallback(async () => {
    setError(null);
    try {
      if (config.layoutPath) {
        const info = await ledLoadLayout(config.layoutPath);
        setLayoutInfo(info);
      } else {
        const info = await ledInitSimple(
          config.broadcastIp,
          config.port,
          config.deviceId,
          config.pixelCount,
        );
        setLayoutInfo(info);
      }
      setConnected(true);
    } catch (e) {
      setError(String(e));
      setConnected(false);
    }
  }, [config, setLayoutInfo, setConnected]);

  const handlePing = useCallback(async () => {
    try {
      await ledPing();
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const handleTestOn = useCallback(async () => {
    try {
      await ledFill(255, 255, 255);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const handleTestOff = useCallback(async () => {
    try {
      await ledAllOff();
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const handleTestColor = useCallback(async (r: number, g: number, b: number) => {
    try {
      await ledFill(r, g, b);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const handleLoadLayout = useCallback(async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (selected) {
        setConfig({ layoutPath: selected as string });
      }
    } catch {}
  }, [setConfig]);

  const startCamera = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 1280, height: 720 },
      });
      setCameraStream(stream);
    } catch (e) {
      setError(`Camera error: ${String(e)}`);
    }
  }, [setCameraStream]);

  const stopCamera = useCallback(() => {
    if (cameraStream) {
      cameraStream.getTracks().forEach((t) => t.stop());
      setCameraStream(null);
    }
  }, [cameraStream, setCameraStream]);

  const captureFrame = useCallback((): { data: number[]; width: number; height: number } | null => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return null;
    canvas.width = video.videoWidth || 1280;
    canvas.height = video.videoHeight || 720;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    return rgbaFromCanvas(canvas);
  }, []);

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const runCalibration = useCallback(async () => {
    if (!connected || !layoutInfo) {
      setError("Connect LED controller first");
      return;
    }

    setCalibrating(true);
    resetCalibration();
    setError(null);

    try {
      await calibrationReset();

      await ledAllOff();
      await sleep(500);

      const baseline = captureFrame();
      if (!baseline) {
        setError("Failed to capture baseline frame");
        setCalibrating(false);
        return;
      }
      await calibrationSetBaseline(baseline.data, baseline.width, baseline.height);

      const totalPixels = layoutInfo.total_pixels;
      const newPoints: CalibrationPoint[] = [];

      for (let i = 0; i < totalPixels; i++) {
        setCalibrationProgress((i + 1) / totalPixels);

        let detected: [number, number] | null = null;

        for (let attempt = 0; attempt < 3; attempt++) {
          await ledAllOff();
          await sleep(100);

          await ledSetPixel(i, 255, 255, 255);
          await sleep(300);

          const litFrame = captureFrame();
          if (!litFrame) continue;

          detected = await calibrationDetectLed(litFrame.data, litFrame.width, litFrame.height);
          if (detected) break;
        }

        if (detected) {
          newPoints.push({ lanternId: i, x: detected[0], y: detected[1] });
        }
      }

      setCalibrationPoints(newPoints);
      await ledAllOff();
    } catch (e) {
      setError(`Calibration error: ${String(e)}`);
    } finally {
      setCalibrating(false);
    }
  }, [connected, layoutInfo, captureFrame, setCalibrating, setCalibrationProgress, setCalibrationPoints, resetCalibration]);

  const labelStyle: React.CSSProperties = {
    fontSize: 10,
    fontWeight: 700,
    color: TEXT2,
    textTransform: "uppercase",
    letterSpacing: 0.8,
    marginBottom: 3,
  };

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
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: BG, color: TEXT, fontFamily: "-apple-system, system-ui, sans-serif", fontSize: 12 }}>
      <div style={{ padding: "6px 8px", borderBottom: `1px solid ${BORDER}`, display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0 }}>
        <span style={{ fontWeight: 700, fontSize: 11, textTransform: "uppercase", letterSpacing: 1, color: ACCENT }}>LED</span>
        <div style={{ display: "flex", gap: 4 }}>
          <button onClick={() => setTab("config")} style={{ background: tab === "config" ? ACCENT : PANEL, border: `1px solid ${tab === "config" ? ACCENT : BORDER}`, color: tab === "config" ? "#fff" : TEXT2, borderRadius: 3, padding: "2px 8px", fontSize: 9, fontWeight: 700, cursor: "pointer" }}>
            Config
          </button>
          <button onClick={() => setTab("calibration")} style={{ background: tab === "calibration" ? ACCENT : PANEL, border: `1px solid ${tab === "calibration" ? ACCENT : BORDER}`, color: tab === "calibration" ? "#fff" : TEXT2, borderRadius: 3, padding: "2px 8px", fontSize: 9, fontWeight: 700, cursor: "pointer" }}>
            Calibrate
          </button>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: 8 }}>
        {tab === "config" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <label style={{ ...labelStyle, marginBottom: 0 }}>
                <input type="checkbox" checked={config.enabled} onChange={(e) => setConfig({ enabled: e.target.checked })} style={{ marginRight: 4 }} />
                Enable
              </label>
              <span style={{ fontSize: 10, color: connected ? "#2ecc71" : TEXT2 }}>
                {connected ? "Connected" : "Disconnected"}
              </span>
            </div>

            <div>
              <div style={labelStyle}>Broadcast IP</div>
              <input style={inputStyle} value={config.broadcastIp} onChange={(e) => setConfig({ broadcastIp: e.target.value })} />
            </div>

            <div style={{ display: "flex", gap: 6 }}>
              <div style={{ flex: 1 }}>
                <div style={labelStyle}>Port</div>
                <input style={inputStyle} type="number" value={config.port} onChange={(e) => setConfig({ port: parseInt(e.target.value) || 7777 })} />
              </div>
              <div style={{ flex: 1 }}>
                <div style={labelStyle}>Device ID</div>
                <input style={inputStyle} type="number" value={config.deviceId} onChange={(e) => setConfig({ deviceId: parseInt(e.target.value) || 1 })} />
              </div>
            </div>

            <div>
              <div style={labelStyle}>Pixel Count</div>
              <input style={inputStyle} type="number" value={config.pixelCount} onChange={(e) => setConfig({ pixelCount: parseInt(e.target.value) || 25 })} />
            </div>

            <div>
              <div style={labelStyle}>Layout File</div>
              <div style={{ display: "flex", gap: 4 }}>
                <input style={{ ...inputStyle, flex: 1 }} value={config.layoutPath ?? ""} readOnly placeholder="None (use simple mode)" />
                <button onClick={handleLoadLayout} style={{ background: PANEL, border: `1px solid ${BORDER}`, color: TEXT, borderRadius: 3, padding: "2px 8px", fontSize: 10, cursor: "pointer", whiteSpace: "nowrap" }}>
                  Browse
                </button>
              </div>
            </div>

            <div>
              <div style={labelStyle}>Brightness</div>
              <input type="range" min={0.05} max={1} step={0.01} value={config.brightness} onChange={(e) => setConfig({ brightness: parseFloat(e.target.value) })} style={{ width: "100%" }} />
              <span style={{ fontSize: 10, color: TEXT2 }}>{(config.brightness * 100).toFixed(0)}%</span>
            </div>

            <div>
              <div style={labelStyle}>Color Gain (R/G/B)</div>
              <div style={{ display: "flex", gap: 4 }}>
                {([0, 1, 2] as const).map((i) => (
                  <input key={i} type="range" min={0.1} max={2} step={0.05} value={config.colorGain[i]} onChange={(e) => {
                    const g = [...config.colorGain] as [number, number, number];
                    g[i] = parseFloat(e.target.value);
                    setConfig({ colorGain: g });
                  }} style={{ flex: 1 }} />
                ))}
              </div>
              <div style={{ display: "flex", gap: 4, justifyContent: "center" }}>
                {(["R", "G", "B"] as const).map((c, i) => (
                  <span key={c} style={{ fontSize: 9, color: TEXT2, width: 50, textAlign: "center" }}>{c}: {config.colorGain[i].toFixed(2)}</span>
                ))}
              </div>
            </div>

            <div style={{ display: "flex", gap: 4 }}>
              <button onClick={handleConnect} style={{ background: ACCENT, color: "#fff", border: "none", borderRadius: 4, padding: "4px 12px", fontSize: 11, fontWeight: 700, cursor: "pointer", flex: 1 }}>
                Connect
              </button>
              <button onClick={handlePing} style={{ background: PANEL, border: `1px solid ${BORDER}`, color: TEXT, borderRadius: 4, padding: "4px 10px", fontSize: 10, cursor: "pointer" }}>
                Ping
              </button>
            </div>

            {layoutInfo && (
              <div style={{ background: "#0d0d15", borderRadius: 4, padding: 6, fontSize: 10 }}>
                <div>Devices: {layoutInfo.device_count} | Pixels: {layoutInfo.total_pixels}</div>
                {layoutInfo.devices.map((d) => (
                  <div key={d.key} style={{ color: TEXT2, marginTop: 2 }}>
                    {d.key} (id:{d.device_id}) {d.controller_ip} - {d.total_pixels}px
                  </div>
                ))}
              </div>
            )}

            <div style={{ borderTop: `1px solid ${BORDER}`, paddingTop: 6 }}>
              <div style={labelStyle}>Test</div>
              <div style={{ display: "flex", gap: 3 }}>
                <button onClick={() => handleTestColor(255, 0, 0)} style={{ background: "#e74c3c", border: "none", borderRadius: 3, padding: "3px 8px", fontSize: 9, cursor: "pointer", color: "#fff" }}>Red</button>
                <button onClick={() => handleTestColor(0, 255, 0)} style={{ background: "#2ecc71", border: "none", borderRadius: 3, padding: "3px 8px", fontSize: 9, cursor: "pointer", color: "#fff" }}>Green</button>
                <button onClick={() => handleTestColor(0, 0, 255)} style={{ background: "#3498db", border: "none", borderRadius: 3, padding: "3px 8px", fontSize: 9, cursor: "pointer", color: "#fff" }}>Blue</button>
                <button onClick={handleTestOn} style={{ background: PANEL, border: `1px solid ${BORDER}`, borderRadius: 3, padding: "3px 8px", fontSize: 9, cursor: "pointer", color: TEXT }}>White</button>
                <button onClick={handleTestOff} style={{ background: PANEL, border: `1px solid ${BORDER}`, borderRadius: 3, padding: "3px 8px", fontSize: 9, cursor: "pointer", color: TEXT2 }}>Off</button>
              </div>
            </div>
          </div>
        )}

        {tab === "calibration" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div>
              <div style={labelStyle}>Camera</div>
              <div style={{ display: "flex", gap: 4 }}>
                <button onClick={cameraStream ? stopCamera : startCamera} style={{ background: cameraStream ? "#e74c3c" : ACCENT, color: "#fff", border: "none", borderRadius: 4, padding: "4px 12px", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
                  {cameraStream ? "Stop Camera" : "Start Camera"}
                </button>
              </div>
            </div>

            {cameraStream && (
              <div style={{ position: "relative", background: "#000", borderRadius: 4, overflow: "hidden", aspectRatio: "16/9" }}>
                <video ref={videoRef} autoPlay playsInline muted style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                <canvas ref={canvasRef} style={{ display: "none" }} />
                {calibrationPoints.length > 0 && (
                  <svg style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", pointerEvents: "none" }}>
                    {calibrationPoints.map((p) => (
                      <circle key={p.lanternId} cx={`${p.x * 100}%`} cy={`${p.y * 100}%`} r={4} fill="#2ecc71" stroke="#fff" strokeWidth={1} />
                    ))}
                  </svg>
                )}
              </div>
            )}

            <button
              onClick={runCalibration}
              disabled={calibrating || !connected || !cameraStream}
              style={{
                background: calibrating ? TEXT2 : ACCENT,
                color: "#fff",
                border: "none",
                borderRadius: 4,
                padding: "6px 12px",
                fontSize: 11,
                fontWeight: 700,
                cursor: calibrating || !connected || !cameraStream ? "not-allowed" : "pointer",
                opacity: calibrating || !connected || !cameraStream ? 0.5 : 1,
              }}
            >
              {calibrating ? `Calibrating... ${(calibrationProgress * 100).toFixed(0)}%` : "Auto Calibrate"}
            </button>

            {calibrating && (
              <div style={{ background: "#0d0d15", borderRadius: 3, height: 6, overflow: "hidden" }}>
                <div style={{ background: ACCENT, height: "100%", width: `${calibrationProgress * 100}%`, transition: "width 0.1s" }} />
              </div>
            )}

            <div style={{ background: "#0d0d15", borderRadius: 4, padding: 6, fontSize: 10 }}>
              <div>Calibrated: {calibrationPoints.length} / {layoutInfo?.total_pixels ?? "?"} LEDs</div>
              {calibrationPoints.length > 0 && (
                <div style={{ maxHeight: 80, overflowY: "auto", marginTop: 4 }}>
                  {calibrationPoints.map((p) => (
                    <div key={p.lanternId} style={{ color: TEXT2 }}>
                      LED #{p.lanternId}: ({p.x.toFixed(3)}, {p.y.toFixed(3)})
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {error && (
          <div style={{ marginTop: 6, padding: 6, background: "#3a1515", borderRadius: 4, fontSize: 10, color: "#ff6b6b" }}>
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
