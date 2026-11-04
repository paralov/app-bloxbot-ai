import { beforeEach, describe, expect, it, vi } from "vitest";

const { config, patchConfig, message } = vi.hoisted(() => ({
  config: { value: {} as Record<string, unknown> },
  patchConfig: vi.fn(async () => {}),
  message: vi.fn(),
}));

vi.mock("@/lib/config", () => ({ loadConfig: async () => config.value, patchConfig }));
vi.mock("@/lib/notifications", () => ({ notify: { message, test: vi.fn() } }));

import { offerNotificationsOnce } from "@/lib/notificationOffer";

const setPlatform = (platform: string) =>
  vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);

describe("offerNotificationsOnce", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    config.value = {
      notificationsOffered: false,
      notificationKinds: null,
      systemNotifications: true,
    };
  });

  it("asks once on a Mac and remembers", async () => {
    setPlatform("MacIntel");
    await offerNotificationsOnce();
    expect(message).toHaveBeenCalledOnce();
    expect(patchConfig).toHaveBeenCalledWith({ notificationsOffered: true });

    message.mockClear();
    config.value = { ...config.value, notificationsOffered: true };
    await offerNotificationsOnce();
    expect(message).not.toHaveBeenCalled();
  });

  it("doesn't ask where the system doesn't need it", async () => {
    setPlatform("Win32");
    await offerNotificationsOnce();
    expect(message).not.toHaveBeenCalled();
  });

  it("doesn't ask someone who turned every kind off", async () => {
    setPlatform("MacIntel");
    config.value = {
      ...config.value,
      notificationKinds: { finished: false, waiting: false, failed: false, app: false },
    };
    await offerNotificationsOnce();
    expect(message).not.toHaveBeenCalled();
  });
});
