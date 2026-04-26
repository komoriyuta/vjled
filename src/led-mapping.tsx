import React from "react";
import ReactDOM from "react-dom/client";
import LedMappingApp from "./windows/led-mapping/LedMappingApp";

ReactDOM.createRoot(document.getElementById("led-mapping-root") as HTMLElement).render(
  <React.StrictMode>
    <LedMappingApp />
  </React.StrictMode>,
);
