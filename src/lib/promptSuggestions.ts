import type { ExplorerNode } from "@/lib/explorer";
import type { Command } from "@/lib/opencode/types";

const MAX_SUGGESTIONS = 12;

export interface SearchableObject {
  node: ExplorerNode;
  name: string;
  searchText: string;
}

export function buildObjectSearchIndex(nodes: readonly ExplorerNode[]): SearchableObject[] {
  const index: SearchableObject[] = [];
  const pending = [...nodes].reverse();
  while (pending.length > 0) {
    const node = pending.pop();
    if (!node) continue;
    index.push({
      node,
      name: node.name.toLowerCase(),
      searchText: `${node.className} ${node.path}`.toLowerCase(),
    });
    for (let childIndex = node.children.length - 1; childIndex >= 0; childIndex -= 1) {
      pending.push(node.children[childIndex]);
    }
  }
  return index;
}

/**
 * "@" opens at the start of any word. Instance names often hold punctuation, so
 * only whitespace ends its query. "/" opens only at the start of the message,
 * since that's the only place a command runs.
 */
export function promptTriggerMatch(trigger: "@" | "/") {
  const pattern = trigger === "@" ? /(^|[\s(])(@(\S{0,75}))$/ : /^()(\/([^\s/]{0,75}))$/;
  return (text: string) => {
    const match = pattern.exec(text);
    if (!match) return null;
    return {
      leadOffset: match.index + match[1].length,
      matchingString: match[3],
      replaceableString: match[2],
    };
  };
}

/** Same as OpenCode's desktop app: the message starts with "/", and the name ends at whitespace. */
export function parseSlashCommand(text: string): { name: string; input: string } | null {
  const message = text.trim();
  if (!message.startsWith("/")) return null;
  const separator = message.search(/\s/);
  return {
    name: message.slice(1, separator === -1 ? undefined : separator),
    input: separator === -1 ? "" : message.slice(separator).trim(),
  };
}

function clientCommand(name: string, description: string): Command {
  return { name, description, template: "", hints: [] };
}

/** OpenCode's desktop commands that act on the app, not on the model. */
export const CLIENT_COMMANDS: readonly Command[] = [
  clientCommand("new", "start a new chat"),
  clientCommand("undo", "take back the last message and put it in the box"),
  clientCommand("redo", "bring back what you undid"),
  clientCommand("compact", "summarize this chat to free up context"),
  clientCommand("fork", "continue from here in a new chat"),
  clientCommand("export", "save this chat as a JSON file"),
  clientCommand("model", "choose a model"),
  clientCommand("connect", "connect a provider"),
  clientCommand("reload", "reload config, commands and skills"),
];

export function mergeCommands(catalog: readonly Command[]): Command[] {
  const clientNames = new Set(CLIENT_COMMANDS.map(({ name }) => name));
  return [...catalog.filter(({ name }) => !clientNames.has(name)), ...CLIENT_COMMANDS];
}

/** Name starts with the query, then name contains it, then class or path contains it. */
function rank(name: string, rest: string, query: string): number | null {
  if (name.startsWith(query)) return 0;
  if (name.includes(query)) return 1;
  return rest.includes(query) ? 2 : null;
}

function best<T>(ranked: Array<{ item: T; score: number }>): T[] {
  return ranked
    .sort((a, b) => a.score - b.score)
    .slice(0, MAX_SUGGESTIONS)
    .map(({ item }) => item);
}

export function searchObjects(
  index: readonly SearchableObject[],
  rawQuery: string,
): ExplorerNode[] {
  const query = rawQuery.toLowerCase();
  const ranked: Array<{ item: ExplorerNode; score: number }> = [];
  for (const entry of index) {
    const score = rank(entry.name, entry.searchText, query);
    if (score !== null) ranked.push({ item: entry.node, score });
  }
  return best(ranked);
}

export function searchCommands(commands: readonly Command[], rawQuery: string): Command[] {
  const query = rawQuery.toLowerCase();
  const ranked: Array<{ item: Command; score: number }> = [];
  for (const command of commands) {
    const score = rank(
      command.name.toLowerCase(),
      (command.description ?? "").toLowerCase(),
      query,
    );
    if (score !== null) ranked.push({ item: command, score });
  }
  return best(ranked);
}
