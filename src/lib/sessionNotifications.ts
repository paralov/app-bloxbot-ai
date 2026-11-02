import type { Event, Session } from "@opencode-ai/sdk/v2/client";
import type { QueryClient } from "@tanstack/react-query";

import { isWindowFocused, notify } from "@/lib/notifications";
import { qk } from "@/lib/queryKeys";
import { maybeShowStarCallout } from "@/lib/starCallout";

type OpenSession = (sessionID: string) => void;

let openSession: OpenSession = () => {};

/** Set by Chat, which can leave Settings too and sits below the provider reading the event stream. */
export function setSessionOpener(opener: OpenSession): void {
  openSession = opener;
}

/**
 * Turns chat events into notifications. A chat the user is looking at already shows all of this, so
 * it only speaks up when the window is in the background or the event is for a different chat.
 */
export class SessionNotifier {
  private readonly busySessions = new Set<string>();

  handleEvent(
    queryClient: QueryClient,
    event: Event,
    activeSessionIdRef: { current: string | null },
  ): void {
    // Helper chats are hidden and subagent chats belong to their parent, so neither counts.
    const userChat = (sessionID: string) => {
      const session = queryClient
        .getQueryData<Session[]>(qk.sessions)
        ?.find((candidate) => candidate.id === sessionID);
      return session && !session.parentID ? session : undefined;
    };

    const announce = (sessionID: string, name: string, title: string, tone?: "error") => {
      const session = userChat(sessionID);
      if (!session) return;
      if (isWindowFocused() && sessionID === activeSessionIdRef.current) return;
      notify.attention(title, {
        name,
        description: session.title,
        tone,
        open: { label: "Open", onClick: () => openSession(sessionID) },
      });
    };

    const finish = (sessionID: string) => {
      // OpenCode reports the end of a turn twice, as an idle status and as session.idle.
      if (!this.busySessions.delete(sessionID)) return;
      announce(sessionID, "chat_finished", "Chat finished");
      if (!userChat(sessionID)) return;
      maybeShowStarCallout().catch((error) => {
        console.warn("Failed to show the GitHub callout:", error);
      });
    };

    switch (event.type) {
      case "session.status": {
        const { sessionID, status } = event.properties;
        if (status.type === "idle") finish(sessionID);
        else this.busySessions.add(sessionID);
        break;
      }
      case "session.idle":
        finish(event.properties.sessionID);
        break;
      case "session.error": {
        const sessionID = event.properties.sessionID ?? activeSessionIdRef.current;
        if (!sessionID) break;
        // Forgetting the turn here keeps the idle event that follows from also saying it finished.
        this.busySessions.delete(sessionID);
        const { error } = event.properties;
        if (error && error.name !== "MessageAbortedError") {
          announce(sessionID, "chat_failed", "Chat ran into a problem", "error");
        }
        break;
      }
      case "question.asked":
        announce(event.properties.sessionID, "chat_question", "BloxBot has a question");
        break;
      case "permission.asked":
        announce(event.properties.sessionID, "chat_permission", "BloxBot needs your approval");
        break;
    }
  }
}

export const sessionNotifier = new SessionNotifier();
