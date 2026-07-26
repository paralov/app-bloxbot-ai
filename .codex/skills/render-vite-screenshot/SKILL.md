---
name: render-vite-screenshot
description: Render and capture BloxBot UI changes through an isolated temporary Vite page and headless browser. Use when screenshots, visual verification, or PR images are needed without launching Electron, activating application windows, using desktop screen capture, or disrupting the user's workspace.
---

# Render Vite Screenshot

Capture only the UI under review. Never launch, focus, resize, inspect, or screenshot the Electron application or the user's desktop windows.

## Workflow

1. Inspect the real component and shared styles. Reuse their markup, classes, copy, and imported `src/index.css`; do not redesign the UI in the harness.
2. Check `git status --short` before creating files. Preserve all user changes.
3. Create a minimal temporary harness in the repository with `apply_patch`:
   - a root HTML entry such as `screenshot.html`;
   - a React entry such as `src/screenshot.tsx` containing only the state being documented;
   - a Vite config without Electron plugins, using React, Tailwind, and the existing `@` alias.
4. Start the harness on a separate strict port, normally `1422`:

   ```sh
   pnpm exec vite --config screenshot.vite.config.ts --port 1422 --strictPort
   ```

5. Capture with headless Chrome. This must not open or activate a visible browser window:

   ```sh
   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
     --headless --disable-gpu --hide-scrollbars \
     --window-size=1200,800 \
     --screenshot=/tmp/bloxbot-screenshot.png \
     http://localhost:1422/screenshot.html
   ```

   If that Chrome path is unavailable, locate another Chromium executable. Do not fall back to macOS `screencapture`, AppleScript window activation, or Electron.
6. Inspect the PNG with the local image viewer. Fix the harness only when it misrepresents the real component. Fix production code only when the user asked for a UI change.
7. Upload the approved PNG with the repository's GitHub image-upload workflow when requested.
8. Stop the Vite process, then delete every temporary harness file with `apply_patch`.
9. Run `git status --short` and confirm no harness files, generated assets, or unrelated changes remain.

## Guardrails

- Do not run `pnpm dev`; its Electron plugin launches the application.
- Do not use `open`, `osascript`, `screencapture`, window IDs, or accessibility permissions.
- Do not reuse the project's normal Vite config when it includes Electron plugins.
- Do not commit the temporary harness or generated screenshot unless explicitly requested.
- Prefer a deterministic representative state over dependence on live OpenCode, Roblox Studio, authentication, or persisted user data.
- State clearly when the image is a Vite rendering of the real component rather than a live Electron capture.
