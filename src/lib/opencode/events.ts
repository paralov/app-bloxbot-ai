import type { OpenCodeEvent } from "@opencode/client";

import {
  assistantInfo,
  textPartId,
  todosFromToolMetadata,
  toModelError,
  toolName,
  toolResult,
  toQuestionRequest,
  toToolPart,
  userInfo,
} from "./messages";
import type { AssistantMessage, Event, Part, Session, ToolPart } from "./types";

type Translated = Event;

const abortedError = {
  name: "MessageAbortedError",
  data: { message: "The response was stopped before it finished." },
} as Extract<Event, { type: "session.error" }>["properties"]["error"];

/**
 * Rebuilds the message-and-part event stream the app consumes from OpenCode 2's events, which
 * describe a turn in smaller steps and leave out anything a client can work out for itself. It holds
 * only what a later event needs: the sessions, the open assistant messages and their tool calls.
 */
export class EventTranslator {
  private readonly sessions = new Map<string, Session>();
  private readonly assistants = new Map<string, AssistantMessage>();
  private readonly tools = new Map<string, ToolPart>();
  private readonly lastUser = new Map<string, string>();

  rememberSession(session: Session): void {
    this.sessions.set(session.id, session);
  }

  forgetSession(sessionID: string): void {
    this.sessions.delete(sessionID);
    this.lastUser.delete(sessionID);
  }

  private updateSession(sessionID: string, change: (session: Session) => Session): Translated[] {
    const session = this.sessions.get(sessionID);
    if (!session) return [];
    const info = change(session);
    this.sessions.set(sessionID, info);
    return [{ type: "session.updated", properties: { sessionID, info } }];
  }

  private textPart(
    sessionID: string,
    messageID: string,
    kind: "text" | "reasoning",
    ordinal: number,
    text: string,
    time: { start: number; end?: number },
  ): Translated {
    const part = {
      id: textPartId(messageID, kind, ordinal),
      sessionID,
      messageID,
      type: kind,
      text,
      time,
    } as Part;
    return { type: "message.part.updated", properties: { sessionID, part, time: time.start } };
  }

  private toolEvent(part: ToolPart): Translated {
    this.tools.set(part.id, part);
    return {
      type: "message.part.updated",
      properties: { sessionID: part.sessionID, part, time: Date.now() },
    };
  }

  private settle(sessionID: string): Translated[] {
    return [
      { type: "session.status", properties: { sessionID, status: { type: "idle" } } },
      { type: "session.idle", properties: { sessionID } },
    ];
  }

  translate(event: OpenCodeEvent): Translated[] {
    const created = "created" in event && typeof event.created === "number" ? event.created : 0;
    switch (event.type) {
      case "session.created": {
        const { data } = event;
        const info = {
          id: data.sessionID,
          slug: data.slug,
          projectID: data.projectID,
          directory: data.location.directory,
          parentID: data.parentID,
          title: data.title ?? "",
          version: data.version,
          metadata: data.metadata,
          time: { created, updated: created },
        } as Session;
        this.sessions.set(info.id, info);
        return [{ type: "session.created", properties: { sessionID: info.id, info } }];
      }
      case "session.renamed":
        return this.updateSession(event.data.sessionID, (session) => ({
          ...session,
          title: event.data.title,
          time: { ...session.time, updated: created },
        }));
      case "session.metadata.updated":
        return this.updateSession(
          event.data.sessionID,
          (session) => ({ ...session, metadata: event.data.metadata }) as Session,
        );
      case "session.archived":
        return this.updateSession(event.data.sessionID, (session) => ({
          ...session,
          time: { ...session.time, archived: created },
        }));
      case "session.unarchived":
        return this.updateSession(event.data.sessionID, (session) => ({
          ...session,
          time: { ...session.time, archived: undefined },
        }));
      case "session.deleted": {
        const { sessionID } = event.data;
        const info = this.sessions.get(sessionID) ?? ({ id: sessionID } as Session);
        this.forgetSession(sessionID);
        return [{ type: "session.deleted", properties: { sessionID, info } }];
      }
      case "session.status":
        return [
          {
            type: "session.status",
            properties: event.data as Extract<Event, { type: "session.status" }>["properties"],
          },
        ];
      case "session.idle":
        return [{ type: "session.idle", properties: { sessionID: event.data.sessionID } }];
      case "session.execution.started":
        return [
          {
            type: "session.status",
            properties: { sessionID: event.data.sessionID, status: { type: "busy" } },
          },
        ];
      case "session.execution.succeeded":
        return this.settle(event.data.sessionID);
      case "session.execution.failed":
        return [
          {
            type: "session.error",
            properties: {
              sessionID: event.data.sessionID,
              error: toModelError(event.data.error),
            },
          },
          ...this.settle(event.data.sessionID),
        ];
      case "session.execution.interrupted":
        return [
          {
            type: "session.error",
            properties: { sessionID: event.data.sessionID, error: abortedError },
          },
          ...this.settle(event.data.sessionID),
        ];
      case "session.retry.scheduled":
        return [
          {
            type: "session.status",
            properties: {
              sessionID: event.data.sessionID,
              status: {
                type: "retry",
                attempt: event.data.attempt,
                message: event.data.error.message,
                next: event.data.at,
              },
            },
          },
        ];
      case "session.inbox.enqueued": {
        const { inboxID, sessionID, item } = event.data;
        if (item.type !== "user") return [];
        this.lastUser.set(sessionID, inboxID);
        const shared = { sessionID, messageID: inboxID };
        const info = userInfo(sessionID, inboxID, created);
        const events: Translated[] = [
          { type: "message.updated", properties: { sessionID, info } },
          {
            type: "message.part.updated",
            properties: {
              sessionID,
              time: created,
              part: { ...shared, id: `${inboxID}:text`, type: "text", text: item.payload.text },
            },
          },
        ];
        for (const [index, file] of (item.payload.files ?? []).entries()) {
          events.push({
            type: "message.part.updated",
            properties: {
              sessionID,
              time: created,
              part: {
                ...shared,
                id: `${inboxID}:file:${index}`,
                type: "file",
                mime: file.mime,
                filename: file.name,
                url: `data:${file.mime};base64,${file.data}`,
              },
            },
          });
        }
        return events;
      }
      case "session.step.started": {
        const { sessionID, assistantMessageID: id, agent, model, started } = event.data;
        const info = assistantInfo(
          sessionID,
          { id, agent, model, time: { created: started } },
          this.lastUser.get(sessionID) ?? "",
        );
        this.assistants.set(id, info);
        return [
          { type: "message.updated", properties: { sessionID, info } },
          {
            type: "message.part.updated",
            properties: {
              sessionID,
              time: started,
              part: { id: `${id}:start`, sessionID, messageID: id, type: "step-start" },
            },
          },
        ];
      }
      case "session.step.ended":
      case "session.step.failed": {
        const { sessionID, assistantMessageID: id } = event.data;
        const previous = this.assistants.get(id);
        if (!previous) return [];
        this.assistants.delete(id);
        const failed = event.type === "session.step.failed";
        const info = {
          ...previous,
          time: { ...previous.time, completed: created },
          cost: event.data.cost ?? previous.cost,
          tokens: event.data.tokens ?? previous.tokens,
          finish: failed ? "error" : event.data.finish,
          error: failed ? toModelError(event.data.error) : undefined,
        } as AssistantMessage;
        const updated: Translated = { type: "message.updated", properties: { sessionID, info } };
        if (failed) return [updated];
        return [
          updated,
          {
            type: "message.part.updated",
            properties: {
              sessionID,
              time: created,
              part: {
                id: `${id}:finish`,
                sessionID,
                messageID: id,
                type: "step-finish",
                reason: event.data.finish,
                cost: info.cost,
                tokens: info.tokens,
              },
            },
          },
        ];
      }
      case "session.text.started":
      case "session.reasoning.started": {
        const { sessionID, assistantMessageID: id, ordinal } = event.data;
        const kind = event.type === "session.text.started" ? "text" : "reasoning";
        return [this.textPart(sessionID, id, kind, ordinal, "", { start: created })];
      }
      case "session.text.delta":
      case "session.reasoning.delta": {
        const { sessionID, assistantMessageID: messageID, ordinal, delta } = event.data;
        const kind = event.type === "session.text.delta" ? "text" : "reasoning";
        return [
          {
            type: "message.part.delta",
            properties: {
              sessionID,
              messageID,
              partID: textPartId(messageID, kind, ordinal),
              field: "text",
              delta,
            },
          },
        ];
      }
      case "session.text.ended":
      case "session.reasoning.ended": {
        const { sessionID, assistantMessageID: id, ordinal, text } = event.data;
        const kind = event.type === "session.text.ended" ? "text" : "reasoning";
        return [
          this.textPart(sessionID, id, kind, ordinal, text, { start: created, end: created }),
        ];
      }
      case "session.tool.input.started": {
        const { sessionID, assistantMessageID: messageID, id, name } = event.data;
        return [
          this.toolEvent(
            toToolPart(sessionID, messageID, {
              type: "tool",
              id,
              name,
              state: { status: "streaming", input: "" },
              time: { created },
            }),
          ),
        ];
      }
      case "session.tool.called": {
        const { sessionID, assistantMessageID: messageID, id, input } = event.data;
        return [
          this.toolEvent(
            toToolPart(sessionID, messageID, {
              type: "tool",
              id,
              name: this.tools.get(id)?.tool ?? "",
              state: { status: "running", input, metadata: {} },
              time: { created, ran: created },
            }),
          ),
        ];
      }
      case "session.tool.success": {
        const { sessionID, assistantMessageID: messageID, id, content, metadata } = event.data;
        const previous = this.tools.get(id);
        if (!previous) return [];
        this.tools.delete(id);
        const start = "time" in previous.state ? previous.state.time.start : created;
        const todos = previous.tool === "todowrite" ? todosFromToolMetadata(metadata) : null;
        const part: ToolPart = {
          ...previous,
          state: {
            status: "completed",
            input: previous.state.input,
            ...toolResult(sessionID, messageID, id, content),
            title: "",
            metadata: metadata ?? {},
            time: { start, end: created },
          },
        };
        return [
          this.toolEvent(part),
          ...(todos
            ? [{ type: "todo.updated", properties: { sessionID, todos } } satisfies Translated]
            : []),
        ];
      }
      case "session.tool.failed": {
        const { id, error, metadata } = event.data;
        const previous = this.tools.get(id);
        if (!previous) return [];
        this.tools.delete(id);
        const start = "time" in previous.state ? previous.state.time.start : created;
        return [
          this.toolEvent({
            ...previous,
            state: {
              status: "error",
              input: previous.state.input,
              error: error.message,
              metadata,
              time: { start, end: created },
            },
          }),
        ];
      }
      case "session.revert.staged": {
        const { messageID } = event.data.revert;
        return this.updateSession(event.data.sessionID, (session) => ({
          ...session,
          revert: { messageID },
        }));
      }
      case "session.revert.cleared":
        return this.updateSession(event.data.sessionID, (session) => ({
          ...session,
          revert: undefined,
        }));
      case "session.revert.committed":
        return [
          ...this.updateSession(event.data.sessionID, (session) => ({
            ...session,
            revert: undefined,
          })),
          { type: "session.compacted", properties: { sessionID: event.data.sessionID } },
        ];
      case "session.compaction.ended":
        return [{ type: "session.compacted", properties: { sessionID: event.data.sessionID } }];
      case "permission.asked":
        return [
          {
            type: "permission.asked",
            properties: {
              id: event.data.id,
              sessionID: event.data.sessionID,
              permission: toolName(event.data.action),
              patterns: [...event.data.resources],
              metadata: event.data.metadata ?? {},
              always: [...(event.data.save ?? [])],
            },
          },
        ];
      case "permission.replied":
        return [{ type: "permission.replied", properties: event.data }];
      case "form.created":
        return [{ type: "question.asked", properties: toQuestionRequest(event.data.form) }];
      case "form.replied":
        return [
          {
            type: "question.replied",
            properties: {
              sessionID: event.data.sessionID,
              requestID: event.data.id,
              answers: Object.values(event.data.answer).map((value) =>
                Array.isArray(value) ? value.map(String) : [String(value)],
              ),
            },
          },
        ];
      case "form.cancelled":
        return [
          {
            type: "question.rejected",
            properties: { sessionID: event.data.sessionID, requestID: event.data.id },
          },
        ];
      default:
        return [];
    }
  }
}
