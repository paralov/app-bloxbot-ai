const MODEL_LINK = /file:\/\/[^\s)\]>"'`]+\.(?:fbx|glb)\b/gi;

/** The model files a reply links to, each once and in order. */
export function modelLinksIn(text: string): string[] {
  return [...new Set(text.match(MODEL_LINK) ?? [])];
}
