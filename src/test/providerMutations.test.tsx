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

    await expect(
      result.current.mutateAsync({ providerID: "opencode-go", modelID: "kimi-k3" }),
    ).resolves.toEqual({
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

  function chatModel(id: string, name = id) {
    return {
      id,
      name,
      status: "active",
      cost: { input: 1, output: 1 },
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
            "gpt-5.6-terra-pro": chatModel("gpt-5.6-terra-pro", "GPT-5.6 Terra Pro"),
            "gpt-5.6-terra": chatModel("gpt-5.6-terra", "GPT-5.6 Terra"),
            "gpt-image": {
              ...chatModel("gpt-image"),
              capabilities: { ...chat, output: { ...chat.output, text: false, image: true } },
            },
          },
        },
      ],
      connected: ["openai"],
      default: { openai: "gpt-5.6-terra-pro" },
    });
    client.session.create.mockReset();
    client.session.create.mockResolvedValue({ data: { id: "check-session" } });
    client.session.delete.mockReset();
    client.session.delete.mockResolvedValue({ data: true });
    client.session.prompt.mockReset();
    client.permission.list.mockResolvedValue({ data: [] });
    capture.mockClear();
    preferences.selectedModel = null;
    setDetailedAnalyticsEnabled(false);
    return qc;
  }

  it("checks the model the user picked, once", async () => {
    const qc = openaiProviders();
    setDetailedAnalyticsEnabled(true);
    client.session.prompt.mockResolvedValue({ data: { info: {}, parts: [] } });

    const { result } = renderHook(() => useCheckProvider(), { wrapper: wrapper(qc) });

    await expect(
      result.current.mutateAsync({ providerID: "openai", modelID: "gpt-5.6-terra" }),
    ).resolves.toEqual({ ok: true, modelName: "GPT-5.6 Terra" });
    expect(client.session.prompt).toHaveBeenCalledOnce();
    expect(client.session.prompt.mock.calls[0][0].model).toEqual({
      providerID: "openai",
      modelID: "gpt-5.6-terra",
    });
    expect(capture).toHaveBeenCalledOnce();
    const [event, properties] = capture.mock.calls[0];
    expect(event).toBe("provider_checked");
    expect(properties).toMatchObject({
      outcome: "success",
      model_choice: "other",
      provider: "openai",
      model: "gpt-5.6-terra",
    });
    expect(properties).not.toHaveProperty("error_message");
  });

  it("reports a failure once, with the model and a scrubbed message", async () => {
    const qc = openaiProviders();
    client.session.prompt.mockResolvedValue({
      data: {
        info: {
          error: {
            name: "APIError",
            data: {
              message:
                "The model is not available on your plan (key sk-proj-abcdefghijklmnop1234).",
              statusCode: 400,
              isRetryable: false,
            },
          },
        },
        parts: [],
      },
    });

    const { result } = renderHook(() => useCheckProvider(), { wrapper: wrapper(qc) });

    await expect(
      result.current.mutateAsync({ providerID: "openai", modelID: "gpt-5.6-terra-pro" }),
    ).resolves.toMatchObject({
      ok: false,
      keyRejected: false,
      modelName: "GPT-5.6 Terra Pro",
    });
    // One attempt only, even though another model could chat.
    expect(client.session.prompt).toHaveBeenCalledOnce();
    expect(client.session.delete).toHaveBeenCalledOnce();
    const properties = capture.mock.calls[0][1];
    expect(properties).toMatchObject({
      outcome: "failure",
      model_choice: "default",
      key_rejected: false,
      error_name: "APIError",
    });
    expect(properties.error_message).toContain("not available on your plan");
    expect(properties.error_message).not.toContain("sk-proj-abcdefghijklmnop1234");
  });

  it("says when the check ran on the model the user chats with", async () => {
    const qc = openaiProviders();
    preferences.selectedModel = "openai/gpt-5.6-terra";
    client.session.prompt.mockResolvedValue({
      data: {
        info: {
          error: { name: "ProviderAuthError", data: { providerID: "openai", message: "Expired" } },
        },
        parts: [],
      },
    });

    const { result } = renderHook(() => useCheckProvider(), { wrapper: wrapper(qc) });

    await expect(
      result.current.mutateAsync({ providerID: "openai", modelID: "gpt-5.6-terra" }),
    ).resolves.toEqual({
      ok: false,
      message: "Expired",
      keyRejected: true,
      modelName: "GPT-5.6 Terra",
    });
    expect(capture.mock.calls[0][1]).toMatchObject({
      model_choice: "selected",
      key_rejected: true,
      error_message: "Expired",
    });
    preferences.selectedModel = null;
  });

  it("doesn't send a check to a model that can't chat", async () => {
    const qc = openaiProviders();

    const { result } = renderHook(() => useCheckProvider(), { wrapper: wrapper(qc) });

    await expect(
      result.current.mutateAsync({ providerID: "openai", modelID: "gpt-image" }),
    ).resolves.toMatchObject({ ok: false, keyRejected: false });
    expect(client.session.create).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
  });
});
