import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { useCheckProvider } from "@/hooks/mutations/useCheckProvider";
import { useDisconnectProvider, useSetApiKey } from "@/hooks/mutations/useSetApiKey";
import { setDetailedAnalyticsEnabled } from "@/lib/analytics";
import { qk } from "@/lib/queryKeys";

const { capture } = vi.hoisted(() => ({ capture: vi.fn() }));
vi.mock("posthog-js/dist/module.full.no-external.js", () => ({
  default: { capture, register: vi.fn() },
}));

const client = {
  auth: { set: vi.fn(), remove: vi.fn() },
  instance: { dispose: vi.fn() },
  provider: { list: vi.fn(), auth: vi.fn() },
  session: { create: vi.fn(), prompt: vi.fn(), delete: vi.fn() },
  permission: { list: vi.fn(), reply: vi.fn() },
};

vi.mock("@/providers/OpenCodeClientProvider", () => ({
  useOpenCodeClient: () => ({ client }),
}));

const preferences = { selectedModel: null as string | null };

vi.mock("@/providers/PreferencesProvider", () => ({
  usePreferences: () => preferences,
}));

const chat = {
  toolcall: true,
  input: { text: true, audio: false, image: false, video: false, pdf: false },
  output: { text: true, audio: false, image: false, video: false, pdf: false },
};

function wrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

describe("useSetApiKey", () => {
  it("reports a saved key as saved when the refresh afterwards fails", async () => {
    client.auth.set.mockResolvedValue({ data: true });
    client.instance.dispose.mockRejectedValue(new Error("instance busy"));
    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, "invalidateQueries").mockResolvedValue();

    const { result } = renderHook(() => useSetApiKey(), { wrapper: wrapper(qc) });

    await expect(
      result.current.mutateAsync({ providerID: "opencode-go", key: "sk-test" }),
    ).resolves.toBeUndefined();
    expect(client.auth.set).toHaveBeenCalledOnce();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.providers });
  });

  it("still fails when the key itself can't be saved", async () => {
    client.auth.set.mockRejectedValue({ name: "BadRequest", data: { message: "bad" } });
    const qc = new QueryClient();

    const { result } = renderHook(() => useSetApiKey(), { wrapper: wrapper(qc) });

    await expect(
      result.current.mutateAsync({ providerID: "opencode-go", key: "sk-test" }),
    ).rejects.toMatchObject({ name: "BadRequest" });
  });
});

describe("useDisconnectProvider", () => {
  it("reports a removed credential as removed when the refresh afterwards fails", async () => {
    client.auth.remove.mockResolvedValue({ data: true });
    client.instance.dispose.mockRejectedValue(new Error("instance busy"));
    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, "invalidateQueries").mockResolvedValue();

    const { result } = renderHook(() => useDisconnectProvider(), { wrapper: wrapper(qc) });

    await expect(result.current.mutateAsync("opencode")).resolves.toBe("opencode");
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.providers });
  });
});

describe("useCheckProvider", () => {
  it("runs the check where no tool can act, rejecting its own approval requests", async () => {
    const qc = new QueryClient();
    qc.setQueryData(qk.providers, {
      all: [
        {
          id: "opencode-go",
          models: {
            "kimi-k3": {
              id: "kimi-k3",
              name: "Kimi K3",
              status: "active",
              cost: { input: 3, output: 15 },
              capabilities: chat,
            },
          },
        },
      ],
      connected: ["opencode-go"],
      default: {},
    });
    client.session.create.mockResolvedValue({ data: { id: "check-session" } });
    client.session.delete.mockResolvedValue({ data: true });
    client.permission.list.mockResolvedValue({
      data: [
        { id: "mine", sessionID: "check-session", permission: "bash" },
        { id: "theirs", sessionID: "user-chat", permission: "edit" },
      ],
    });
    // The model asks to run a tool; the prompt only finishes once that is rejected.
    let rejected: () => void = () => {};
    const rejection = new Promise<void>((resolve) => {
      rejected = resolve;
    });
    client.permission.reply.mockImplementation(async () => {
      rejected();
      return { data: true };
    });
    client.session.prompt.mockImplementation(async () => {
      await rejection;
      return { data: { info: {}, parts: [] } };
    });

    const { result } = renderHook(() => useCheckProvider(), { wrapper: wrapper(qc) });

    await expect(result.current.mutateAsync("opencode-go")).resolves.toEqual({
      ok: true,
      modelName: "Kimi K3",
    });
    expect(client.session.create.mock.calls[0][0].permission).toEqual([
      { permission: "*", pattern: "*", action: "ask" },
    ]);
    expect(client.permission.reply).toHaveBeenCalledWith({ requestID: "mine", reply: "reject" });
    expect(client.permission.reply).not.toHaveBeenCalledWith(
      expect.objectContaining({ requestID: "theirs" }),
    );
    expect(client.session.delete).toHaveBeenCalledWith(
      { sessionID: "check-session" },
      { throwOnError: true },
    );
  });

  it("checks the model the user chats with when it's from this provider", async () => {
    const qc = new QueryClient();
    const models = {
      cheap: {
        id: "cheap",
        name: "Cheap",
        status: "active",
        cost: { input: 0, output: 0 },
        capabilities: chat,
      },
      std: {
        id: "std",
        name: "Standard",
        status: "active",
        cost: { input: 1, output: 5 },
        capabilities: chat,
      },
      "org/picked": {
        id: "org/picked",
        name: "Picked",
        status: "active",
        cost: { input: 3, output: 15 },
        capabilities: chat,
      },
    };
    qc.setQueryData(qk.providers, {
      all: [{ id: "openrouter", models }],
      connected: ["openrouter"],
      default: { openrouter: "std" },
    });
    client.session.create.mockResolvedValue({ data: { id: "check-session" } });
    client.session.delete.mockResolvedValue({ data: true });
    client.permission.list.mockResolvedValue({ data: [] });
    client.session.prompt.mockResolvedValue({ data: { info: {}, parts: [] } });
    preferences.selectedModel = "openrouter/org/picked";
    const { result, rerender } = renderHook(() => useCheckProvider(), { wrapper: wrapper(qc) });
    await expect(result.current.mutateAsync("openrouter")).resolves.toEqual({
      ok: true,
      modelName: "Picked",
    });
    expect(client.session.prompt.mock.lastCall?.[0].model).toEqual({
      providerID: "openrouter",
      modelID: "org/picked",
    });

    // A model from another provider doesn't count; the provider's default is next.
    preferences.selectedModel = "anthropic/claude-sonnet";
    rerender();
    await expect(result.current.mutateAsync("openrouter")).resolves.toMatchObject({
      modelName: "Standard",
    });
    preferences.selectedModel = null;
  });

  function chatModel(id: string, cost: number) {
    return {
      id,
      name: id,
      status: "active",
      cost: { input: cost, output: cost },
      capabilities: chat,
    };
  }

  function openaiProviders() {
    const qc = new QueryClient();
    qc.setQueryData(qk.providers, {
      all: [
        {
          id: "openai",
          models: {
            "gpt-5.6-terra-pro": chatModel("gpt-5.6-terra-pro", 15),
            "gpt-5.6-terra": chatModel("gpt-5.6-terra", 2),
            "gpt-5.6-mini": chatModel("gpt-5.6-mini", 0.5),
          },
        },
      ],
      connected: ["openai"],
      default: { openai: "gpt-5.6-terra" },
    });
    let sessions = 0;
    client.session.create.mockReset();
    client.session.create.mockImplementation(async () => ({
      data: { id: `check-${++sessions}` },
    }));
    client.session.delete.mockReset();
    client.session.delete.mockResolvedValue({ data: true });
    client.session.prompt.mockReset();
    client.permission.list.mockResolvedValue({ data: [] });
    capture.mockClear();
    preferences.selectedModel = null;
    setDetailedAnalyticsEnabled(false);
    return qc;
  }

  const planError = {
    name: "APIError",
    data: {
      message:
        "The model gpt-5.6-terra-pro is not available on your plan (key sk-proj-abcdefghijklmnop1234).",
      statusCode: 400,
      isRetryable: false,
    },
  };

  it("tries the next model once when the first fails for a reason other than the key", async () => {
    const qc = openaiProviders();
    preferences.selectedModel = "openai/gpt-5.6-terra-pro";
    setDetailedAnalyticsEnabled(true);
    client.session.prompt
      .mockResolvedValueOnce({ data: { info: { error: planError }, parts: [] } })
      .mockResolvedValueOnce({ data: { info: {}, parts: [] } });

    const { result } = renderHook(() => useCheckProvider(), { wrapper: wrapper(qc) });

    await expect(result.current.mutateAsync("openai")).resolves.toEqual({
      ok: true,
      modelName: "gpt-5.6-terra",
    });
    expect(client.session.prompt.mock.calls.map(([body]) => body.model.modelID)).toEqual([
      "gpt-5.6-terra-pro",
      "gpt-5.6-terra",
    ]);
    // Each attempt gets its own hidden session, and both are removed.
    expect(client.session.create).toHaveBeenCalledTimes(2);
    expect(client.session.delete.mock.calls.map(([body]) => body.sessionID)).toEqual([
      "check-1",
      "check-2",
    ]);
    expect(capture).toHaveBeenCalledOnce();
    const [event, properties] = capture.mock.calls[0];
    expect(event).toBe("provider_checked");
    expect(properties).toMatchObject({
      outcome: "success",
      model_choice: "default",
      attempts: 2,
      model: "gpt-5.6-terra",
      first_model: "gpt-5.6-terra-pro",
    });
    expect(properties.first_error_message).toContain("not available on your plan");
    expect(properties.first_error_message).not.toContain("sk-proj-abcdefghijklmnop1234");
    expect(properties).not.toHaveProperty("error_message");
    setDetailedAnalyticsEnabled(false);
    preferences.selectedModel = null;
  });

  it("reports the last failure when the second model fails too", async () => {
    const qc = openaiProviders();
    client.session.prompt.mockResolvedValue({
      data: {
        info: {
          error: { name: "APIError", data: { message: "Overloaded", statusCode: 529 } },
        },
        parts: [],
      },
    });

    const { result } = renderHook(() => useCheckProvider(), { wrapper: wrapper(qc) });

    await expect(result.current.mutateAsync("openai")).resolves.toEqual({
      ok: false,
      message: "Overloaded",
      keyRejected: false,
    });
    // At most two attempts, though a third model is available.
    expect(client.session.prompt).toHaveBeenCalledTimes(2);
    expect(client.session.delete).toHaveBeenCalledTimes(2);
    expect(capture.mock.calls[0][1]).toMatchObject({
      outcome: "failure",
      model_choice: "cheapest",
      attempts: 2,
      key_rejected: false,
      error_name: "APIError",
      error_message: "Overloaded",
      first_error_message: "Overloaded",
    });
  });

  it("doesn't retry when the key or sign-in is rejected", async () => {
    const qc = openaiProviders();
    client.session.prompt.mockResolvedValue({
      data: {
        info: {
          error: { name: "ProviderAuthError", data: { providerID: "openai", message: "Expired" } },
        },
        parts: [],
      },
    });

    const { result } = renderHook(() => useCheckProvider(), { wrapper: wrapper(qc) });

    await expect(result.current.mutateAsync("openai")).resolves.toEqual({
      ok: false,
      message: "Expired",
      keyRejected: true,
    });
    expect(client.session.prompt).toHaveBeenCalledOnce();
    expect(client.session.delete).toHaveBeenCalledWith(
      { sessionID: "check-1" },
      { throwOnError: true },
    );
    const properties = capture.mock.calls[0][1];
    expect(properties).toMatchObject({
      outcome: "failure",
      model_choice: "default",
      attempts: 1,
      key_rejected: true,
      error_name: "ProviderAuthError",
      error_message: "Expired",
    });
    expect(properties).not.toHaveProperty("first_error_message");
    expect(properties).not.toHaveProperty("first_model");
  });
});
