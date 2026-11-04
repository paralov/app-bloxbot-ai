import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "@/components/theme-provider";

const hidden = vi.hoisted(() => ({ toggle: vi.fn(), set: new Set<string>() }));

const model = (id: string, name: string, providerId: string, providerName: string) => ({
  id,
  name,
  providerId,
  providerName,
  status: "active",
});

vi.mock("@/hooks/useProviders", () => ({
  useAllProviders: () => [
    { id: "anthropic", name: "Anthropic", source: "api", models: {} },
    { id: "openai", name: "OpenAI", source: "custom", models: {} },
  ],
  useConnectedProviders: () => ["anthropic"],
  useAllModels: () => [
    model("opus", "Claude Opus", "anthropic", "Anthropic"),
    model("haiku", "Claude Haiku", "anthropic", "Anthropic"),
    model("gpt", "GPT", "openai", "OpenAI"),
  ],
  useAuthMethods: () => ({}),
  useProviderList: () => undefined,
}));
vi.mock("@/providers/PreferencesProvider", () => ({
  usePreferences: () => ({
    selectedModel: null,
    hiddenModels: hidden.set,
    toggleModelVisibility: hidden.toggle,
  }),
}));

import Settings from "@/components/Settings";

function open() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ThemeProvider>
        <Settings onClose={() => {}} />
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

describe("Settings: providers and their models", () => {
  beforeEach(() => {
    hidden.toggle.mockClear();
    hidden.set = new Set();
  });

  it("has one place for providers and models", async () => {
    open();
    await screen.findByRole("heading", { name: "Providers" });
    expect(screen.queryByRole("button", { name: "Models" })).not.toBeInTheDocument();
  });

  it("lists a connected provider's models under it, and turns them on and off", async () => {
    open();
    const summary = await screen.findByRole("button", { name: "2 models" });
    expect(screen.queryByText("Claude Opus")).not.toBeInTheDocument();

    fireEvent.click(summary);
    fireEvent.click(screen.getByRole("switch", { name: "Show Claude Opus in the chat" }));

    expect(hidden.toggle).toHaveBeenCalledWith("anthropic/opus");
    // Nothing is listed for a provider that isn't connected yet.
    expect(screen.queryByText("GPT")).not.toBeInTheDocument();
  });

  it("says when some models are hidden", async () => {
    hidden.set = new Set(["anthropic/haiku"]);
    open();
    expect(await screen.findByRole("button", { name: "1 of 2 models shown" })).toBeInTheDocument();
  });

  it("finds a model by name and opens its provider to it", async () => {
    open();
    fireEvent.change(await screen.findByLabelText("Search providers"), {
      target: { value: "haiku" },
    });

    expect(screen.getByText("Claude Haiku")).toBeInTheDocument();
    expect(screen.queryByText("Claude Opus")).not.toBeInTheDocument();
    expect(screen.queryByText("OpenAI")).not.toBeInTheDocument();
  });
});
