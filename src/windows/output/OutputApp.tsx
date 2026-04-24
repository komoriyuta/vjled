import { useRef } from "react";
import { useEngine } from "../../hooks/useEngine";

export default function OutputApp() {
  const containerRef = useRef<HTMLDivElement>(null);
  useEngine({ outputContainerRef: containerRef, preview: false });

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
