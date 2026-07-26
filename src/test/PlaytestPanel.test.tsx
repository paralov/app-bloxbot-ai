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
    detailedAnalytics: "disabled",
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
    fireEvent.click(screen.getByRole("button", { name: "Generate test plan" }));
    expect(await screen.findByDisplayValue("Test rounds")).toBeInTheDocument();
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
    fireEvent.click(screen.getByRole("button", { name: "Generate test plan" }));
    expect(await screen.findByText("Couldn't create a playtest plan")).toBeInTheDocument();
    expect(client.session.delete).toHaveBeenCalledWith({ sessionID: "planner" });
  });
});
