import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import ProviderConnectDialog from "@/components/ProviderConnectDialog";

const startOAuth = vi.fn();
const completeOAuth = vi.fn();
const openUrl = vi.fn();

vi.mock("@/hooks/mutations/useOAuth", () => ({
  useStartOAuth: () => ({ mutateAsync: startOAuth }),
  useCompleteOAuth: () => ({ mutateAsync: completeOAuth }),
  captureProviderConnectFailure: vi.fn(),
}));
vi.mock("@/hooks/mutations/useSetApiKey", () => ({
  useSetApiKey: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("@/hooks/useProviders", () => ({
  useAuthMethods: () => ({
    openai: [
      { type: "oauth", label: "ChatGPT Pro/Plus (browser)" },
      { type: "oauth", label: "ChatGPT Pro/Plus (headless)" },
      { type: "api", label: "Manually enter API Key" },
    ],
  }),
  useConnectedProviders: () => [],
}));
vi.mock("@/lib/desktop", () => ({ desktop: { openUrl: (url: string) => openUrl(url) } }));
vi.mock("@/components/ProviderLogo", () => ({ default: () => null }));

const openai = { id: "openai", name: "OpenAI", env: [] };

describe("ProviderConnectDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    openUrl.mockResolvedValue(undefined);
  });

  it("drops a sign-in the user left while it was still starting", async () => {
    let finishAuthorize: (value: unknown) => void = () => {};
    startOAuth.mockReturnValue(
      new Promise((resolve) => {
        finishAuthorize = resolve;
      }),
    );
    const onClose = vi.fn();
    render(<ProviderConnectDialog provider={openai} onClose={onClose} onConnected={vi.fn()} />);

    fireEvent.click(screen.getByText("Sign in with ChatGPT"));
    expect(screen.getByText("Starting sign-in…")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();

    await act(async () => {
      finishAuthorize({ method: "auto", instructions: "", url: "https://auth.openai.com/x" });
    });

    expect(openUrl).not.toHaveBeenCalled();
    expect(completeOAuth).not.toHaveBeenCalled();
  });

  it("opens the sign-in page and waits for approval while the user stays", async () => {
    startOAuth.mockResolvedValue({
      method: "auto",
      instructions: "",
      url: "https://auth.openai.com/x",
    });
    completeOAuth.mockReturnValue(new Promise(() => {}));
    render(<ProviderConnectDialog provider={openai} onClose={vi.fn()} onConnected={vi.fn()} />);

    await act(async () => {
      fireEvent.click(screen.getByText("Sign in with ChatGPT"));
    });

    expect(openUrl).toHaveBeenCalledWith("https://auth.openai.com/x");
    expect(completeOAuth).toHaveBeenCalledWith({ providerID: "openai", methodIndex: 0 });
  });
});
