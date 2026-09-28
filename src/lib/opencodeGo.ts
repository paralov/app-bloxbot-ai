// OpenCode Go is OpenCode's own subscription for open coding models. It connects
// like any API-key provider, and both plans share the `opencode-go` provider.
// Prices from https://opencode.ai/docs/go, checked 2026-09-28.
export const OPENCODE_GO = {
  providerId: "opencode-go",
  plansUrl: "https://opencode.ai/go",
  consoleUrl: "https://opencode.ai/console/go",
  goPrice: "$10/month",
  goPlusPrice: "$40/month",
} as const;

/**
 * Recommend Go to people who have only the free OpenCode Zen models, so the
 * cheapest paid step up is in front of them before they reach for API keys.
 */
export function shouldRecommendOpenCodeGo(connectedProviders: string[]): boolean {
  return connectedProviders.every((id) => id === "opencode");
}
