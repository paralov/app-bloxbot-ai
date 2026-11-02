import type { ExplorerNode } from "@/lib/explorer";
import type { Command } from "@/lib/opencode/types";

const MAX_SUGGESTIONS = 8;

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
 * Matches "@" or "/" at the start of a word. Instance names often hold
 * punctuation, so only whitespace ends the query. A second "/" means a path,
 * not a command.
 */
export function promptTriggerMatch(trigger: "@" | "/") {
  const pattern = trigger === "@" ? /(^|[\s(])(@(\S{0,75}))$/ : /(^|[\s(])(\/([^\s/]{0,75}))$/;
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
