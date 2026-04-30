import { useRef } from "react";
import { useEngine } from "../../hooks/useEngine";
import { useLedStore } from "../../stores/ledStore";
import { useVJStore } from "../../stores/vjStore";

export default function OutputApp() {
  const containerRef = useRef<HTMLDivElement>(null);
  const ledConfig = useLedStore((s) => s.config);
  const ledPoints = useLedStore((s) => s.calibrationPoints);

  useEngine({
    outputContainerRef: containerRef,
    preview: false,
    ledConfig,
    ledPoints,
    getBpm: () => useVJStore.getState().bpm,
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
