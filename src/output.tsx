import React from "react";
import ReactDOM from "react-dom/client";
import OutputApp from "./windows/output/OutputApp";

ReactDOM.createRoot(document.getElementById("output-root") as HTMLElement).render(
  <React.StrictMode>
    <OutputApp />
  </React.StrictMode>,
);
