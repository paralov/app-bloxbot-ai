import { useQueryClient } from "@tanstack/react-query";
import posthog from "posthog-js/dist/module.full.no-external.js";
import { useMemo } from "react";
import { useCreateSession } from "@/hooks/mutations/useCreateSession";
import { useCommands } from "@/hooks/useCommands";
import { analyticsProperties } from "@/lib/analytics";
import { notify } from "@/lib/notifications";
import type { Session } from "@/lib/opencode/types";
import { CLIENT_COMMANDS, mergeCommands, parseSlashCommand } from "@/lib/promptSuggestions";
import { qk } from "@/lib/queryKeys";
import { splitModelKey } from "@/lib/splitModelKey";
import type { MessagesCache } from "@/lib/sseDispatch";
import { useActiveSession } from "@/providers/ActiveSessionProvider";
import { useOpenCodeClient } from "@/providers/OpenCodeClientProvider";
import { usePreferences } from "@/providers/PreferencesProvider";

const BUILT_IN = new Set(["init", "review", "goal", ...CLIENT_COMMANDS.map(({ name }) => name)]);

/** Failed commands report status too, like what a bare /goal says about the current goal. */
function isCommandReport(error: unknown): error is Error {
  return error instanceof Error && error.name === "CommandExecutionError";
}

function goalConfirmation(argument: string): string {
  const control = argument.toLowerCase();
  if (control === "pause") return "Goal paused";
  if (control === "resume") return "Goal resumed";
  if (control === "clear") return "Goal cleared";
  return "Goal set. BloxBot will keep working until it's met.";
}

function saveJson(filename: string, data: unknown) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * The slash commands OpenCode's desktop app has. Some run here, and the rest are
 * in OpenCode's catalog: /goal, /init, /review, and custom, MCP and skill commands.
 */
export function useComposerCommands(actions: {
  chooseModel: () => void;
  openSettings: () => void;
  restoreDraft: (text: string) => void;
}) {
  const { client } = useOpenCodeClient();
  const { activeSessionId, selectSession } = useActiveSession();
  const { selectedModel, selectedVariant } = usePreferences();
  const queryClient = useQueryClient();
  const createSession = useCreateSession();
  const catalog = useCommands();
  const commands = useMemo(() => mergeCommands(catalog), [catalog]);

  function userMessages() {
    if (!activeSessionId) return [];
    const cache = queryClient.getQueryData<MessagesCache>(qk.messages(activeSessionId));
    return (cache?.messageIds ?? []).flatMap((id) => {
      const message = cache?.messagesById[id];
      const isPrompt =
        message?.info.role === "user" &&
        message.parts.some((part) => part.type === "text" || part.type === "file");
      return isPrompt ? [message] : [];
    });
  }

  const revertedMessage = () =>
    queryClient
      .getQueryData<Session[]>(qk.sessions)
      ?.find((session) => session.id === activeSessionId)?.revert?.messageID;

  async function runClientCommand(name: string, sessionID: string) {
    if (!client) return;
    const options = { throwOnError: true as const };
    switch (name) {
      case "new":
        createSession.mutate();
        return;
      case "model":
        actions.chooseModel();
        return;
      case "connect":
        actions.openSettings();
        return;
      case "reload":
        await client.location.reload(options);
        await queryClient.invalidateQueries({ queryKey: qk.commands });
        notify.success("Config reloaded");
        return;
      case "undo": {
        const prompts = userMessages();
        const reverted = revertedMessage();
        const boundary = reverted
          ? prompts.findIndex((message) => message.info.id === reverted)
          : prompts.length;
        const target = boundary > 0 ? prompts[boundary - 1] : undefined;
        if (!target) {
          notify.message("Nothing to undo");
          return;
        }
        await client.session.undo({ sessionID, messageID: target.info.id }, options);
        const text = target.parts.flatMap((part) => (part.type === "text" ? [part.text] : []));
        actions.restoreDraft(text.join("\n"));
        notify.message("Message undone", {
          description:
            "Files are back as they were. Changes made in Studio stay, so use Studio's undo for those.",
        });
        return;
      }
      case "redo":
        if (!revertedMessage()) {
          notify.message("Nothing to redo");
          return;
        }
        await client.session.redo({ sessionID }, options);
        return;
      case "compact":
        if (userMessages().length === 0) {
          notify.message("Nothing to compact yet");
          return;
        }
        await client.session.compact({ sessionID }, options);
        return;
      case "fork": {
        const forked = await client.session.fork({ sessionID }, options);
        if (!forked.data) return;
        const session = forked.data;
        queryClient.setQueryData<Session[]>(qk.sessions, (previous) =>
          previous?.some(({ id }) => id === session.id) ? previous : [session, ...(previous ?? [])],
        );
        await selectSession(session.id);
        return;
      }
      case "export": {
        const { data } = await client.session.exportData({ sessionID }, options);
        const filename = `${(data?.info.title || sessionID).toLowerCase().replace(/[^a-z0-9_-]+/g, "-")}.json`;
        saveJson(filename, data);
        notify.success("Chat exported", { description: filename });
        return;
      }
    }
  }

  async function runServerCommand(
    name: string,
    argument: string,
    sessionID: string,
    images: ReadonlyArray<{ mime: string; url: string; filename?: string }>,
    system: string | null,
  ) {
    if (!client) return;
    const [providerID, modelID] = selectedModel ? splitModelKey(selectedModel) : [];
    await client.session.command(
      {
        sessionID,
        name,
        parts: [
          { type: "text", text: argument },
          ...images.map((image) => ({ type: "file", ...image })),
        ],
        model: providerID && modelID ? { providerID, modelID } : undefined,
        variant: selectedVariant ?? undefined,
        system: system ?? undefined,
      } as Parameters<typeof client.session.command>[0],
      { throwOnError: true },
    );
    if (name === "goal" && argument) notify.message(goalConfirmation(argument));
  }

  /**
   * Runs the text as a command when it names one, and says whether it did.
   * Commands run even while a reply streams, so /goal pause can stop a goal.
   */
  function run(
    text: string,
    context: {
      images?: ReadonlyArray<{ mime: string; url: string; filename?: string }>;
      system?: string | null;
      onFailed: (error: Error) => void;
    },
  ): boolean {
    const parsed = parseSlashCommand(text);
    if (!parsed || !activeSessionId) return false;
    const isClient = CLIENT_COMMANDS.some(({ name }) => name === parsed.name);
    if (!isClient && !catalog.some(({ name }) => name === parsed.name)) return false;

    posthog.capture(
      "composer_command_run",
      analyticsProperties("chat", {
        command: BUILT_IN.has(parsed.name) ? parsed.name : "custom",
        runs_in: isClient ? "client" : "server",
      }),
    );
    const running = isClient
      ? runClientCommand(parsed.name, activeSessionId)
      : runServerCommand(
          parsed.name,
          parsed.input,
          activeSessionId,
          context.images ?? [],
          context.system ?? null,
        );
    running.catch((error: unknown) => {
      if (isCommandReport(error)) {
        const [title, ...details] = error.message.split("\n");
        notify.message(title, { description: details.join(" ") || undefined });
        return;
      }
      context.onFailed(error instanceof Error ? error : new Error(String(error)));
    });
    return true;
  }

  return { commands, run };
}
