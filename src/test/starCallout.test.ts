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

  it("doesn't count a prompt that failed to send", async () => {
    await recordPromptSent(Promise.reject(new Error("offline")));
    expect((await loadConfig()).promptsSent ?? 0).toBe(0);
  });

  it("waits for the third prompt, then asks only once", async () => {
    await recordPromptSent(Promise.resolve());
    await recordPromptSent(Promise.resolve());
    await maybeShowStarCallout();
    expect(message).not.toHaveBeenCalled();

    await recordPromptSent(Promise.resolve());
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

  // Last, since its stuck request stays pending for the rest of the file.
  it("keeps counting when an earlier request never returns", async () => {
    void recordPromptSent(new Promise(() => {}));
    await recordPromptSent(Promise.resolve());
    expect((await loadConfig()).promptsSent).toBe(1);
  });
});
