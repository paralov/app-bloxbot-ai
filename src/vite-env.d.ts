/// <reference types="vite/client" />

import type { DesktopApi } from "@/types/desktop";

declare global {
  interface ImportMetaEnv {
    readonly VITE_POSTHOG_PROJECT_TOKEN?: string;
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }

  interface Window {
    bloxbot?: DesktopApi;
  }
}
