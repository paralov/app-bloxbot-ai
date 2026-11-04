export type SettingsRequest = "uploads";

const listeners = new Set<(request: SettingsRequest) => void>();

/** Lets a toast, which lives outside the chat, open a part of Settings. */
export function requestSettings(request: SettingsRequest): void {
  for (const listener of listeners) listener(request);
}

export function onSettingsRequest(listener: (request: SettingsRequest) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
