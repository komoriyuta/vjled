import { useEffect, useRef } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useEngine } from "../../hooks/useEngine";
import { useLedStore } from "../../stores/ledStore";
import { listenLedState, requestLedState } from "../../events/vjEvents";
import { ledInitSimple, ledLoadLayout } from "../../led/commands";

function outputWindowLabel(): string {
  try {
    return getCurrentWebviewWindow().label;
  } catch {
    return "output";
  }
}

export default function OutputApp() {
  const containerRef = useRef<HTMLDivElement>(null);
  const isPrimaryOutputRef = useRef(outputWindowLabel() === "output");
  const ledConfig = useLedStore((s) => s.config);
  const ledPoints = useLedStore((s) => s.calibrationPoints);
  const setConnected = useLedStore((s) => s.setConnected);
  const setLayoutInfo = useLedStore((s) => s.setLayoutInfo);

  useEffect(() => {
    requestLedState();
    const unlisten = listenLedState((state) => {
      const led = useLedStore.getState();
      led.loadSyncedState(state.config, state.calibrationPoints, state.layoutInfo, state.connected, state.mappingHandles, state.rawCameraPoints);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    if (!isPrimaryOutputRef.current) return;
    if (!ledConfig.enabled) return;
    let cancelled = false;

    void (async () => {
      try {
        const info = ledConfig.layoutPath
          ? await ledLoadLayout(ledConfig.layoutPath)
          : await ledInitSimple(ledConfig.broadcastIp, ledConfig.port, ledConfig.deviceId, ledConfig.pixelCount);
        if (cancelled) return;
        setLayoutInfo(info);
        setConnected(true);
      } catch (e) {
        if (!cancelled) {
          setConnected(false);
          console.error("LED output sender init failed:", e);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [ledConfig.enabled, ledConfig.layoutPath, ledConfig.broadcastIp, ledConfig.port, ledConfig.deviceId, ledConfig.pixelCount, setConnected, setLayoutInfo]);

  useEngine({
    outputContainerRef: containerRef,
    preview: false,
    ledConfig,
    ledPoints,
    enableLedOutput: isPrimaryOutputRef.current,
  });

  return (
    <div
      ref={containerRef}
      style={{
        width: "100vw",
        height: "100vh",
        background: "#000",
        position: "relative",
        overflow: "hidden",
      }}
    />
  );
}
