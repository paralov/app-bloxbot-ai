import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { fetchMessages, mergeMessagesSnapshot } from "@/hooks/useMessages";
import { qk } from "@/lib/queryKeys";
import type { MessagesCache } from "@/lib/sseDispatch";
import type { MessageWithParts } from "@/types";

function message(id: string, text: string): MessageWithParts {
  return {
    info: { id, sessionID: "s1", role: "assistant" },
    parts: [{ id: `${id}-part`, sessionID: "s1", messageID: id, type: "text", text }],
  } as MessageWithParts;
}

describe("message snapshot reconciliation", () => {
  it("preserves messages updated by SSE while an HTTP snapshot is loading", () => {
    const before: MessagesCache = {
      messageIds: ["m1"],
      messagesById: { m1: message("m1", "before") },
    };
    const fetched: MessagesCache = {
      messageIds: ["m1"],
      messagesById: { m1: message("m1", "stale fetch") },
    };
    const after: MessagesCache = {
      messageIds: ["m1", "m2"],
      messagesById: {
        m1: message("m1", "streamed update"),
        m2: message("m2", "streamed addition"),
      },
    };

    const merged = mergeMessagesSnapshot(before, fetched, after);

    expect(merged.messageIds).toEqual(["m1", "m2"]);
    expect(merged.messagesById.m1).toBe(after.messagesById.m1);
    expect(merged.messagesById.m2).toBe(after.messagesById.m2);
  });

  it("does not resurrect a message removed by SSE during the fetch", () => {
    const retained = message("m2", "retained");
    const before: MessagesCache = {
      messageIds: ["m1", "m2"],
      messagesById: { m1: message("m1", "before"), m2: retained },
    };
    const fetched: MessagesCache = {
      messageIds: ["m1", "m2"],
      messagesById: { m1: message("m1", "stale fetch"), m2: message("m2", "fresh fetch") },
    };
    const after: MessagesCache = {
      messageIds: ["m2"],
      messagesById: { m2: retained },
    };

    const merged = mergeMessagesSnapshot(before, fetched, after);

    expect(merged.messageIds).toEqual(["m2"]);
    expect(merged.messagesById.m1).toBeUndefined();
  });

  it("does not resurrect a message added and removed while the snapshot loads", () => {
    const transient = message("m1", "transient");
    const fetched: MessagesCache = {
      messageIds: ["m1"],
      messagesById: { m1: message("m1", "stale fetch") },
    };
    const after: MessagesCache = { messageIds: [], messagesById: {} };

    const merged = mergeMessagesSnapshot(undefined, fetched, after, new Set([transient.info.id]));

    expect(merged.messageIds).toEqual([]);
    expect(merged.messagesById.m1).toBeUndefined();
  });

  it("records an add-then-remove cache event while the HTTP request is pending", async () => {
    let resolveRequest: ((value: unknown) => void) | undefined;
    const request = new Promise((resolve) => {
      resolveRequest = resolve;
    });
    const client = {
      session: { messages: vi.fn().mockReturnValue(request) },
    } as unknown as OpencodeClient;
    const queryClient = new QueryClient();
    queryClient.setQueryData<MessagesCache>(qk.messages("s1"), {
      messageIds: [],
      messagesById: {},
    });

    const resultPromise = fetchMessages(client, queryClient, "s1");
    const transient = message("m1", "streamed");
    queryClient.setQueryData<MessagesCache>(qk.messages("s1"), {
      messageIds: ["m1"],
      messagesById: { m1: transient },
    });
    queryClient.setQueryData<MessagesCache>(qk.messages("s1"), {
      messageIds: [],
      messagesById: {},
    });
    resolveRequest?.({ data: [{ info: transient.info, parts: transient.parts }] });

    await expect(resultPromise).resolves.toEqual({ messageIds: [], messagesById: {} });
  });
});
