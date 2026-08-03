import type { Message, Part } from "@opencode-ai/sdk/v2/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { describe, expect, it, vi } from "vitest";
import PlaytestPanel from "@/components/PlaytestPanel";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { qk } from "@/lib/queryKeys";
import type { MessagesCache } from "@/lib/sseDispatch";
import { ActiveSessionContext } from "@/providers/ActiveSessionProvider";
import { OpenCodeClientContext } from "@/providers/OpenCodeClientProvider";
import { PreferencesProvider } from "@/providers/PreferencesProvider";

const { capture } = vi.hoisted(() => ({ capture: vi.fn() }));
vi.mock("posthog-js/dist/module.full.no-external.js", () => ({
  default: { capture },
}));

function Harness({
  client,
  onClose = vi.fn(),
}: {
  client: Record<string, unknown>;
  onClose?: () => void;
}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(qk.config, {
    lastModel: "anthropic/claude",
    hiddenModels: [],
    theme: "system",
    telemetryNoticeShown: true,
    usageAnalytics: "on",
    crashReports: "on",
    studioTargetPrograms: null,
    studioTargetsBySession: {},
  });
  queryClient.setQueryData<MessagesCache>(qk.messages("active"), {
    messageIds: ["m1"],
    messagesById: {
      m1: {
        info: { role: "user" } as Message,
        parts: [{ type: "text", text: "Build a round system" } as Part],
      },
    },
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

describe("PlaytestPanel", () => {
  it("generates through a tool-disabled temporary session, then sends the edited plan normally", async () => {
    const onClose = vi.fn();
    const client = {
      session: {
        create: vi.fn().mockResolvedValue({ data: { id: "planner" } }),
        prompt: vi.fn().mockResolvedValue({
          data: {
            info: {
              structured: {
                goal: "Test rounds",
                steps: ["Start a round"],
                watchFor: ["Console errors"],
                successCriteria: ["Round completes"],
              },
            },
          },
        }),
        delete: vi.fn().mockResolvedValue({}),
        promptAsync: vi.fn().mockResolvedValue({}),
      },
    };
    render(<Harness client={client} onClose={onClose} />);
    expect(client.session.create).not.toHaveBeenCalled();
    expect(client.session.prompt).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Generate from chat" }));
    expect(capture).toHaveBeenCalledWith(
      "generation_started",
      expect.objectContaining({
        analytics_schema_version: 1,
        feature: "playtest",
      }),
    );
    expect(await screen.findByDisplayValue("Test rounds")).toBeInTheDocument();
    expect(capture).toHaveBeenCalledWith(
      "generation_succeeded",
      expect.objectContaining({
        analytics_schema_version: 1,
        feature: "playtest",
      }),
    );
    expect(client.session.prompt.mock.calls[0][0]).toMatchObject({
      sessionID: "planner",
      format: { type: "json_schema" },
    });
    expect(client.session.create.mock.calls[0][0].permission).toEqual([
      { permission: "*", pattern: "*", action: "deny" },
    ]);
    expect(client.session.delete).toHaveBeenCalledWith({ sessionID: "planner" });

    fireEvent.change(screen.getByLabelText("Goal"), { target: { value: "Test two rounds" } });
    fireEvent.click(screen.getByRole("button", { name: "Run playtest" }));
    await waitFor(() => expect(client.session.promptAsync).toHaveBeenCalledOnce());
    expect(client.session.promptAsync.mock.calls[0][0].sessionID).toBe("active");
    expect(client.session.promptAsync.mock.calls[0][0].parts[0].text).toContain("Test two rounds");
    expect(client.session.promptAsync.mock.calls[0][0].tools).toBeUndefined();
    expect(onClose).toHaveBeenCalled();
  });

  it("shows an error and cleans up when structured output is invalid", async () => {
    const client = {
      session: {
        create: vi.fn().mockResolvedValue({ data: { id: "planner" } }),
        prompt: vi
          .fn()
          .mockResolvedValue({ data: { info: { structured: { goal: "Missing lists" } } } }),
        delete: vi.fn().mockResolvedValue({}),
        promptAsync: vi.fn(),
      },
    };
    render(<Harness client={client} />);
    fireEvent.click(screen.getByRole("button", { name: "Generate from chat" }));
    expect(await screen.findByText("Couldn't create a playtest plan")).toBeInTheDocument();
    expect(client.session.delete).toHaveBeenCalledWith({ sessionID: "planner" });
  });

  it("opens blank manual fields without calling the planning agent", () => {
    const client = {
      session: {
        create: vi.fn(),
        prompt: vi.fn(),
        delete: vi.fn(),
        promptAsync: vi.fn(),
      },
    };
    render(<Harness client={client} />);
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
