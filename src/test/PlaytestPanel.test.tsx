import type { Message, Part } from "@opencode-ai/sdk/v2/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PlaytestPanel from "@/components/PlaytestPanel";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { setDetailedAnalyticsEnabled } from "@/lib/analytics";
import { qk } from "@/lib/queryKeys";
import type { MessagesCache } from "@/lib/sseDispatch";
import { ActiveSessionContext } from "@/providers/ActiveSessionProvider";
import { OpenCodeClientContext } from "@/providers/OpenCodeClientProvider";
import { PreferencesProvider } from "@/providers/PreferencesProvider";
import type { MessageWithParts } from "@/types";

const { capture } = vi.hoisted(() => ({ capture: vi.fn() }));
vi.mock("posthog-js/dist/module.full.no-external.js", () => ({
  default: { capture, register: vi.fn() },
}));

const CHAT: MessageWithParts[] = [
  {
    info: { id: "m1", role: "user" } as Message,
    parts: [{ type: "text", text: "Build a round system" } as Part],
  },
];

const PLAN = {
  goal: "Test rounds",
  steps: ["Start a round"],
  watchFor: ["Console errors"],
  successCriteria: ["Round completes"],
};

function plannerClient(prompt: ReturnType<typeof vi.fn>) {
  return {
    session: {
      create: vi.fn().mockResolvedValue({ data: { id: "planner" } }),
      prompt,
      delete: vi.fn().mockResolvedValue({}),
      promptAsync: vi.fn().mockResolvedValue({}),
    },
    permission: {
      list: vi.fn().mockResolvedValue({ data: [] }),
      reply: vi.fn().mockResolvedValue({ data: true }),
    },
  };
}

function Harness({
  client,
  onClose = vi.fn(),
  messages = CHAT,
  detailedAnalytics = "disabled",
}: {
  client: Record<string, unknown>;
  onClose?: () => void;
  messages?: MessageWithParts[];
  detailedAnalytics?: "enabled" | "disabled";
}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(qk.config, {
    lastModel: "anthropic/claude",
    hiddenModels: [],
    theme: "system",
    detailedAnalytics,
    analyticsNoticeVersion: 2,
  });
  queryClient.setQueryData<MessagesCache>(qk.messages("active"), {
    messageIds: messages.map((m) => m.info.id),
    messagesById: Object.fromEntries(messages.map((m) => [m.info.id, m])),
  });
  const activeSessionIdRef = useRef<string | null>("active");
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <OpenCodeClientContext.Provider
          value={{
            client: client as never,
            status: "ready",
            port: 1,
            ready: true,
            initError: null,
          }}
        >
          <ActiveSessionContext.Provider
            value={{
              activeSessionId: "active",
              activeSessionIdRef,
              selectSession: async () => {},
              clearSession: () => {},
            }}
          >
            <PreferencesProvider>
              <PlaytestPanel onClose={onClose} />
              <Toaster />
            </PreferencesProvider>
          </ActiveSessionContext.Provider>
        </OpenCodeClientContext.Provider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

function capturedEvents(): string[] {
  return capture.mock.calls.map(([event]) => event as string);
}

describe("PlaytestPanel", () => {
  beforeEach(() => capture.mockClear());
  afterEach(() => setDetailedAnalyticsEnabled(false));

  it("generates through a hidden session whose tool requests are rejected, then sends the edited plan normally", async () => {
    const onClose = vi.fn();
    const client = plannerClient(vi.fn());
    // The model asks to run a tool. The prompt only finishes once that is rejected.
    client.permission.list.mockResolvedValue({
      data: [
        { id: "planner-ask", sessionID: "planner", permission: "bash" },
        { id: "chat-ask", sessionID: "active", permission: "edit" },
      ],
    });
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
      return { data: { info: { structured: PLAN }, parts: [] } };
    });

    render(<Harness client={client} onClose={onClose} />);
    expect(client.session.create).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Generate from chat" }));
    expect(capture).toHaveBeenCalledWith("generation_started", {
      analytics_schema_version: 1,
      feature: "playtest",
    });
    expect(await screen.findByDisplayValue("Test rounds")).toBeInTheDocument();
    expect(capture).toHaveBeenCalledWith("generation_succeeded", {
      analytics_schema_version: 1,
      feature: "playtest",
    });
    expect(capturedEvents()).not.toContain("generation_failed");
    expect(client.session.prompt.mock.calls[0][0]).toMatchObject({
      sessionID: "planner",
      format: { type: "json_schema" },
    });
    // "deny" would drop every tool from the request, including the
    // StructuredOutput tool, and OpenCode's free tier rejects tool-less requests.
    const created = client.session.create.mock.calls[0][0];
    expect(created.permission).toEqual([{ permission: "*", pattern: "*", action: "ask" }]);
    expect(created.metadata).toMatchObject({ bloxbotHidden: true });
    expect(client.permission.reply).toHaveBeenCalledWith({
      requestID: "planner-ask",
      reply: "reject",
    });
    expect(client.permission.reply).not.toHaveBeenCalledWith(
      expect.objectContaining({ requestID: "chat-ask" }),
    );
    expect(client.session.delete).toHaveBeenCalledWith({ sessionID: "planner" });

    fireEvent.change(screen.getByLabelText("Goal"), { target: { value: "Test two rounds" } });
    fireEvent.click(screen.getByRole("button", { name: "Run playtest" }));
    await waitFor(() => expect(client.session.promptAsync).toHaveBeenCalledOnce());
    expect(client.session.promptAsync.mock.calls[0][0].sessionID).toBe("active");
    expect(client.session.promptAsync.mock.calls[0][0].parts[0].text).toContain("Test two rounds");
    expect(client.session.promptAsync.mock.calls[0][0].tools).toBeUndefined();
    expect(onClose).toHaveBeenCalled();
  });

  it("shows the planner's model error instead of calling the plan invalid", async () => {
    const client = plannerClient(
      vi.fn().mockResolvedValue({
        data: {
          info: {
            error: {
              name: "APIError",
              data: {
                message: "OpenCode's free tier can only be used from within OpenCode",
                statusCode: 403,
                isRetryable: false,
              },
            },
          },
          parts: [],
        },
      }),
    );
    render(<Harness client={client} detailedAnalytics="enabled" />);
    fireEvent.click(screen.getByRole("button", { name: "Generate from chat" }));
    expect(
      await screen.findByText("OpenCode's free tier can only be used from within OpenCode"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/invalid test plan/)).not.toBeInTheDocument();
    expect(capture).toHaveBeenCalledWith(
      "generation_failed",
      expect.objectContaining({
        error_category: "model_error",
        model_error_name: "APIError",
        error_message: "OpenCode's free tier can only be used from within OpenCode",
      }),
    );
    expect(client.session.delete).toHaveBeenCalledWith({ sessionID: "planner" });
  });

  it("reports an invalid plan only when the planner answered without an error", async () => {
    const client = plannerClient(
      vi.fn().mockResolvedValue({ data: { info: { structured: { goal: "Missing lists" } } } }),
    );
    render(<Harness client={client} />);
    fireEvent.click(screen.getByRole("button", { name: "Generate from chat" }));
    expect(await screen.findByText("Couldn't create a playtest plan")).toBeInTheDocument();
    expect(screen.getByText("The planner returned an incomplete test plan.")).toBeInTheDocument();
    expect(client.session.delete).toHaveBeenCalledWith({ sessionID: "planner" });
  });

  it("turns generate off in a chat with no text and keeps manual entry", () => {
    const client = plannerClient(vi.fn());
    render(
      <Harness
        client={client}
        messages={[
          {
            info: { id: "m1", role: "assistant" } as Message,
            parts: [{ type: "tool" } as Part, { type: "text", text: "   " } as Part],
          },
        ]}
      />,
    );
    const generate = screen.getByRole("button", { name: "Generate from chat" });
    expect(generate).toBeDisabled();
    expect(generate).toHaveAccessibleDescription(
      "Plans are built from this chat. Send a message first, or write your own.",
    );
    fireEvent.click(generate);
    expect(client.session.create).not.toHaveBeenCalled();
    expect(capturedEvents()).not.toContain("generation_started");
    expect(capturedEvents()).not.toContain("generation_failed");

    const manual = screen.getByRole("button", { name: "Write my own" });
    expect(manual).toBeEnabled();
    fireEvent.click(manual);
    expect(screen.getByLabelText("Goal")).toHaveValue("");
    // With a manual plan open, Regenerate is off and says why.
    const regenerate = screen.getByRole("button", { name: "Regenerate" });
    expect(regenerate).toBeDisabled();
    expect(regenerate).toHaveAccessibleDescription(
      "Regenerate builds a plan from this chat. Send a message first.",
    );
  });

  it("opens blank manual fields without calling the planning agent", () => {
    const client = plannerClient(vi.fn());
    render(<Harness client={client} />);
    expect(screen.getByRole("button", { name: "Generate from chat" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Write my own" }));
    expect(screen.getByLabelText("Goal")).toHaveValue("");
    expect(screen.getByLabelText("Steps 1")).toHaveValue("");
    expect(client.session.create).not.toHaveBeenCalled();
    expect(client.session.prompt).not.toHaveBeenCalled();
    expect(capture).toHaveBeenCalledWith("manual_entry_selected", {
      analytics_schema_version: 1,
      feature: "playtest",
    });
  });
});
