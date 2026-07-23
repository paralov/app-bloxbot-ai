import { pathToFileURL } from "node:url";

export const POSTHOG_API_HOST = "https://eu.i.posthog.com";

const POSTHOG_PROJECT_TOKEN_PATTERN = /^phc_[A-Za-z0-9]+$/;

export function requirePostHogProjectToken(value: string | undefined): string {
  const token = value?.trim() ?? "";
  if (!POSTHOG_PROJECT_TOKEN_PATTERN.test(token)) {
    throw new Error(
      "POSTHOG_PROJECT_TOKEN must be configured as a valid GitHub Actions repository variable.",
    );
  }
  return token;
}

export async function validatePostHogProjectToken(
  token: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const response = await fetcher(`${POSTHOG_API_HOST}/flags/?v=2&config=true`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token,
      distinct_id: "bloxbot-ci-token-validation",
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (response.ok) return;

  const payload = (await response.json().catch(() => null)) as { detail?: unknown } | null;
  const detail = typeof payload?.detail === "string" ? `: ${payload.detail}` : "";
  throw new Error(`PostHog EU rejected the project token with HTTP ${response.status}${detail}`);
}

async function main(): Promise<void> {
  const token = requirePostHogProjectToken(process.env.POSTHOG_PROJECT_TOKEN);
  await validatePostHogProjectToken(token);
  process.stdout.write("PostHog EU project token is valid.\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
