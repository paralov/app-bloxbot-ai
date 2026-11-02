import { beforeEach, describe, expect, it, vi } from "vitest";

const { message, focused, openUrl } = vi.hoisted(() => ({
  message: vi.fn(),
  focused: vi.fn(() => true),
  openUrl: vi.fn(async () => {}),
}));

vi.mock("@/lib/notifications", () => ({ isWindowFocused: focused, notify: { message } }));
vi.mock("@/lib/desktop", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/desktop")>();
  return { ...actual, desktop: { ...actual.desktop, openUrl } };
});

import { loadConfig } from "@/lib/config";
import { maybeShowStarCallout, recordPromptSent, showStarCallout } from "@/lib/starCallout";

describe("GitHub star callout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    focused.mockReturnValue(true);
  });

  it("waits for the third prompt, then asks only once", async () => {
    await recordPromptSent();
    await recordPromptSent();
    await maybeShowStarCallout();
    expect(message).not.toHaveBeenCalled();

    await recordPromptSent();
    await maybeShowStarCallout();
    expect(message).toHaveBeenCalledOnce();
    expect(message.mock.calls[0][0]).toBe("Enjoying BloxBot?");

    await maybeShowStarCallout();
    expect(message).toHaveBeenCalledOnce();
    await expect(loadConfig()).resolves.toMatchObject({ starCalloutShown: true });
  });

  it("skips the prompt count for a returning user, and still asks only once", async () => {
    focused.mockReturnValue(false);

    await showStarCallout();
    await showStarCallout();
    await maybeShowStarCallout();

    expect(message).toHaveBeenCalledOnce();
  });
});
