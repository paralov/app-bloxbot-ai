import React from "react";
import ReactDOM from "react-dom/client";
import DebugLogs from "@/components/DebugLogs";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <main className="flex h-full flex-col overflow-hidden">
      <DebugLogs />
    </main>
  </React.StrictMode>,
);
