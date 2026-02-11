import React from "react";
import ReactDOM from "react-dom/client";
import DebugLogs from "./components/DebugLogs";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <DebugLogs />
  </React.StrictMode>,
);
