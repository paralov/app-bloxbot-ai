import { createHash } from "node:crypto";

import { type ExplorerNode, type ExplorerSyncResult, sortExplorerNodes } from "../src/lib/explorer";
import {
  type CallStudioTool,
  mcpData,
  mcpError,
  readHistoryState,
  VISIBLE_SERVICES,
} from "./studioQueries";

// Studio answers about one call per frame, and more than this at once only makes each one wait.
const CONCURRENT_READS = 3;
// A read blocks Studio for as long as it runs, about 10ms per thousand rows, so one that would list
// more than this is split up. It can't be paged: the tool has no offset.
const READ_LIMIT = 3_000;
const NO_LIMIT = 1_000_000;
const MAX_DEPTH = 10;
// Past this many objects to read one by one, a single long read is quicker for everyone.
const MAX_SPLIT = 256;
const MAX_NODES = 500_000;
// How far to look when objects sharing a path have to be read from above, stopping at the first
// that holds all of them. Every other object down to that depth comes along, so shallower is better.
const SHARED_PATH_DEPTHS = [2, 4, 7, MAX_DEPTH];
// The watcher relies on Studio's change events. A slow check costs little if one ever stops firing.
const SAFETY_READ_MS = 60_000;

interface Read {
  readonly rows: readonly any[];
  readonly truncated: boolean;
  readonly hash: string;
}

/** A place in the tree one read can start from. */
interface Anchor {
  readonly path: string;
  readonly id: string;
}

interface Plan {
  readonly hash: string;
  /** Too big for one read last time, so don't try again. */
  readonly splits: boolean;
  readonly hasTwins: boolean;
  readonly frontier: readonly Anchor[];
  readonly nodes: number;
  /** How deep the objects sharing a path went last time, to start there. */
  readonly sharedPathDepth?: number;
}

interface TreeState {
  model: string | null;
  rootHash: string | null;
  treeVersion: string | null;
  complete: boolean;
  readAt: number;
  plans: Map<string, Plan>;
}

const trees = new Map<string, TreeState>();

/** Forgets what's been read from Studio, for tests. */
export function resetExplorerTrees() {
  trees.clear();
}

class ObjectGone extends Error {}

const hashOf = (text: string) => createHash("sha1").update(text).digest("base64");

function rowsOf(data: unknown): readonly any[] | null {
  if (Array.isArray(data)) return data;
  const instances = (data as { instances?: unknown } | null)?.instances;
  return Array.isArray(instances) ? instances : null;
}

const rowPathOf = (row: any): string =>
  typeof row?.fullPath === "string" ? row.fullPath : typeof row?.path === "string" ? row.path : "";

const rowNameOf = (row: any, path: string): string => {
  const properties = row?.properties && typeof row.properties === "object" ? row.properties : {};
  const name = [properties.Name, row?.Name, row?.name].find(
    (candidate) => typeof candidate === "string" && candidate,
  );
  return name ?? path.split(".").at(-1) ?? path;
};

const hiddenChildrenOf = (row: any) => Number(row?.unexploredChildCount ?? 0);

/** The object's own path, whatever start Studio wrote it with. */
const gamePath = (path: string) => (path.startsWith("game.") ? path : `game.${path}`);

// The name, not the last period, because a name can contain one.
const parentPathOf = (path: string, name: string) =>
  path.endsWith(`.${name}`)
    ? path.slice(0, -name.length - 1)
    : path.slice(0, Math.max(path.lastIndexOf("."), 0));

async function readTree(
  callTool: CallStudioTool,
  args: Record<string, unknown>,
): Promise<{ read: Read } | { error: string }> {
  const result = await callTool("search_game_tree", args);
  const error = mcpError(result);
  if (error) return { error };
  const data = mcpData(result);
  if (typeof data === "string" && data.startsWith("Error:")) throw new ObjectGone(data);
  const rows = rowsOf(data);
  if (!rows) throw new Error("Studio returned an unreadable instance tree");
  const text = (result.content ?? []).find((part) => part.type === "text");
  return {
    read: {
      rows,
      truncated: (result.content ?? []).some(
        (part) => part.type === "text" && /^Note: Output limited/.test(part.text),
      ),
      hash: hashOf(text?.type === "text" ? text.text : JSON.stringify(rows)),
    },
  };
}

/**
 * The services, which also says which data model is open: Studio requires "Edit" normally and
 * rejects it during a playtest, so this falls back to the server, then to the client when Studio
 * can't reach the server (Play Solo on recent Studio builds).
 */
async function readRoot(callTool: CallStudioTool, studioId: string) {
  const errors: Array<[string, string]> = [];
  for (const model of ["Edit", "Server", "Client"]) {
    const answer = await readTree(callTool, {
      studio_id: studioId,
      datamodel_type: model,
      max_depth: 1,
      head_limit: NO_LIMIT,
    });
    if ("read" in answer) return { model, rows: answer.read.rows };
    errors.push([model, answer.error]);
  }
  // Attempts that only say a data model "is not available in … mode" add nothing.
  const [[, first] = ["", ""], ...rest] = errors;
  const details = rest
    .filter(([, error]) => error !== first && !/not available in \w+ mode/i.test(error))
    .map(([type, error]) => `${type.toLowerCase()} data model: ${error}`);
  throw new Error(details.length > 0 ? `${first} (${details.join("; ")})` : first);
}

interface BuiltNode {
  id?: string;
  occurrence?: number;
  occurrences?: number;
  name: string;
  className: string;
  path: string;
  hasChildren: boolean;
  pending?: boolean;
  children: BuiltNode[];
}

/**
 * Turns one read's rows into the objects under where it started. Studio lists a level at a time, so
 * the children of objects sharing a path are in their order. Where the split between them falls
 * isn't in the rows, so `countsAt` asks for it: rows at the edge of a read say how many they hold.
 */
async function buildChildren(
  rows: readonly any[],
  anchor: Anchor,
  countsAt: (level: number) => Promise<ReadonlyMap<string, readonly number[]>>,
) {
  const byPath = new Map<string, { node: BuiltNode; hidden: number; rowIndex: number }[]>();
  for (const [rowIndex, row] of rows.entries()) {
    const path = rowPathOf(row);
    if (!path) continue;
    const entry = {
      rowIndex,
      hidden: hiddenChildrenOf(row),
      node: {
        name: rowNameOf(row, path),
        className: typeof row?.className === "string" ? row.className : "Instance",
        path: gamePath(path),
        hasChildren: false,
        children: [],
      },
    };
    const entries = byPath.get(path);
    if (entries) entries.push(entry);
    else byPath.set(path, [entry]);
  }

  const levels = new Map<string, number>([[anchor.path, 0]]);
  const reachable = new Map<string, boolean>([[anchor.path, true]]);
  const childPaths = new Map<string, string[]>();
  for (const [path, entries] of byPath) {
    if (path === anchor.path) continue;
    const { name } = entries[0].node;
    const parentPath = parentPathOf(path, name);
    const siblings = childPaths.get(parentPath);
    if (siblings) siblings.push(path);
    else childPaths.set(parentPath, [path]);
    // Parents come first, because of the order of the rows.
    levels.set(path, (levels.get(parentPath) ?? 0) + 1);
    // A path only reaches the first object with it, and a period in a name breaks it.
    reachable.set(
      path,
      (reachable.get(parentPath) ?? false) && entries.length === 1 && !name.includes("."),
    );
    if (entries.length > 1) {
      entries.forEach(({ node }, occurrence) => {
        node.occurrence = occurrence;
        node.occurrences = entries.length;
      });
    }
  }

  let hasTwins = false;
  const top: BuiltNode = {
    name: "",
    className: "",
    path: "",
    hasChildren: false,
    children: [],
  };
  const link = async (parentPath: string, parents: readonly BuiltNode[]) => {
    const paths = childPaths.get(parentPath) ?? [];
    const rowsBelow = paths.flatMap((path) => byPath.get(path) ?? []);
    if (rowsBelow.length === 0) return;
    if (parents.length === 1) {
      parents[0].children = rowsBelow.map(({ node }) => node);
    } else {
      hasTwins = true;
      const counts = (await countsAt(levels.get(parentPath) ?? 0)).get(parentPath) ?? [];
      const children = rowsBelow.sort((a, b) => a.rowIndex - b.rowIndex).map(({ node }) => node);
      let next = 0;
      parents.forEach((parent, index) => {
        // Anything Studio didn't account for stays visible under the last one.
        const count = index === parents.length - 1 ? children.length - next : (counts[index] ?? 0);
        parent.children = children.slice(next, next + count);
        next += count;
      });
    }
    for (const path of paths) {
      await link(
        path,
        (byPath.get(path) ?? []).map(({ node }) => node),
      );
    }
  };
  await link(anchor.path, [top]);

  // Each id comes from its parent's, with a number for the ones after the first with a name.
  const identify = (nodes: readonly BuiltNode[], parentId: string) => {
    const used = new Map<string, number>();
    for (const node of nodes) {
      const index = used.get(node.name) ?? 0;
      used.set(node.name, index + 1);
      node.id = `${parentId}${node.name}${index > 0 ? `#${index}` : ""}`;
      node.hasChildren = node.children.length > 0;
      identify(node.children, `${node.id}.`);
    }
  };
  identify(top.children, `${anchor.id}.`);

  // What this read stopped short of. Nothing can reach below an object that shares a path, so those
  // don't offer an arrow that would do nothing.
  const frontier: Anchor[] = [];
  for (const [path, entries] of byPath) {
    if (!reachable.get(path) || path === anchor.path) continue;
    for (const { hidden, node } of entries) {
      if (hidden <= 0 || node.children.length > 0 || !node.id) continue;
      node.hasChildren = true;
      node.pending = true;
      frontier.push({ path, id: node.id });
    }
  }

  return {
    children: sortExplorerNodes(top.children as unknown as ExplorerNode[]),
    frontier,
    hasTwins,
    nodes: rows.length,
  };
}

interface SyncOptions {
  /** The caller has nothing yet, so it needs everything sent. */
  readonly fresh: boolean;
  /** Read even if the watcher says nothing changed, because the caller just edited something. */
  readonly force: boolean;
  readonly onUpdate: (update: {
    parentId: string | null;
    children: readonly ExplorerNode[];
    placeName?: string;
  }) => void;
  readonly signal?: AbortSignal;
}

/**
 * Brings the caller's tree up to date, sending each changed part as it arrives. A big place takes
 * many short reads instead of one long one, so Studio stays responsive, and when Studio's watcher
 * says nothing changed there's nothing to read at all.
 */
export async function syncExplorerTree(
  callTool: CallStudioTool,
  studioId: string,
  { fresh, force, onUpdate, signal }: SyncOptions,
): Promise<ExplorerSyncResult> {
  const known = trees.get(studioId);
  const state: TreeState =
    !fresh && known
      ? known
      : {
          model: null,
          rootHash: null,
          treeVersion: null,
          complete: false,
          readAt: 0,
          plans: new Map(),
        };
  trees.set(studioId, state);

  let slowestReadMs = 0;
  const timed = async <A>(read: () => Promise<A>): Promise<A> => {
    const startedAt = performance.now();
    const answer = await read();
    slowestReadMs = Math.max(slowestReadMs, performance.now() - startedAt);
    return answer;
  };

  // Read before the walk, so a change that lands during it shows up as a change next time.
  const [history, root] = await Promise.all([
    readHistoryState(callTool, studioId).catch(() => ({ treeVersion: null })),
    timed(() => readRoot(callTool, studioId)),
  ]);
  const { model } = root;
  const services = root.rows.filter((row) => {
    const path = rowPathOf(row);
    return path && row?.className !== "DataModel" && VISIBLE_SERVICES.has(path.split(".")[0]);
  });
  const placeName =
    root.rows.find((row) => row?.className === "DataModel" && typeof row?.name === "string")?.name ||
    "Roblox Studio";
  const rootHash = hashOf(JSON.stringify([placeName, services]));
  const watching = history.treeVersion !== null && model === "Edit";

  if (
    !force &&
    !fresh &&
    watching &&
    state.complete &&
    Date.now() - state.readAt < SAFETY_READ_MS &&
    state.model === model &&
    state.treeVersion === history.treeVersion &&
    state.rootHash === rootHash
  ) {
    return { changed: false, watching, complete: true, truncated: false, slowestReadMs };
  }
  if (state.model !== model) state.plans.clear();

  let changed = false;
  let truncated = false;
  let complete = true;
  let nodeCount = services.length;
  let firstError: unknown = null;
  const seen = new Set<string>();
  const queue: Anchor[] = [];

  const send = (parentId: string | null, children: readonly ExplorerNode[], name?: string) => {
    changed = true;
    onUpdate({ parentId, children, ...(name ? { placeName: name } : {}) });
  };

  const rootNodes: BuiltNode[] = services.map((row) => {
    const path = rowPathOf(row);
    const name = rowNameOf(row, path);
    const hidden = hiddenChildrenOf(row);
    if (hidden > 0) queue.push({ path, id: gamePath(path) });
    return {
      id: gamePath(path),
      name,
      className: typeof row?.className === "string" ? row.className : "Instance",
      path: gamePath(path),
      hasChildren: hidden > 0,
      ...(hidden > 0 ? { pending: true } : {}),
      children: [],
    };
  });
  if (state.rootHash !== rootHash || state.model !== model) {
    send(null, sortExplorerNodes(rootNodes as unknown as ExplorerNode[]), placeName);
  }

  const read = async (path: string, depth: number, limit: number): Promise<Read> => {
    const answer = await timed(() =>
      readTree(callTool, {
        studio_id: studioId,
        datamodel_type: model,
        path,
        max_depth: depth,
        head_limit: limit,
      }),
    );
    if ("error" in answer) throw new Error(answer.error);
    return answer.read;
  };

  const absorb = async (anchor: Anchor, whole: Read, splits: boolean, sharedPathDepth?: number) => {
    if (whole.truncated) truncated = true;
    const before = state.plans.get(anchor.path);
    let plan: Plan;
    if (before && !before.hasTwins && before.hash === whole.hash && before.splits === splits) {
      plan = before;
    } else {
      const counts = new Map<number, Promise<ReadonlyMap<string, readonly number[]>>>();
      const countHashes: string[] = [];
      const built = await buildChildren(whole.rows, anchor, (level) => {
        const pending =
          counts.get(level) ??
          read(anchor.path, level, NO_LIMIT).then((edge) => {
            countHashes.push(edge.hash);
            const found = new Map<string, number[]>();
            for (const row of edge.rows) {
              const path = rowPathOf(row);
              const list = found.get(path);
              if (list) list.push(hiddenChildrenOf(row));
              else found.set(path, [hiddenChildrenOf(row)]);
            }
            return found;
          });
        counts.set(level, pending);
        return pending;
      });
      const hash = built.hasTwins ? hashOf(whole.hash + countHashes.join("")) : whole.hash;
      plan = {
        hash,
        splits,
        hasTwins: built.hasTwins,
        frontier: built.frontier,
        nodes: built.nodes,
        ...(sharedPathDepth ? { sharedPathDepth } : {}),
      };
      if (signal?.aborted) return;
      if (before?.hash !== hash) send(anchor.id, built.children);
    }
    state.plans.set(anchor.path, plan);
    nodeCount += plan.nodes;
    queue.push(...plan.frontier);
  };

  const visit = async (anchor: Anchor) => {
    seen.add(anchor.path);
    if (nodeCount > MAX_NODES) {
      truncated = true;
      return;
    }
    if (!state.plans.get(anchor.path)?.splits) {
      const probe = await read(anchor.path, MAX_DEPTH, READ_LIMIT);
      if (!probe.truncated) return absorb(anchor, probe, false);
    }
    const level = await read(anchor.path, 1, NO_LIMIT);
    const toRead = level.rows.filter(
      (row) => rowPathOf(row) !== anchor.path && hiddenChildrenOf(row) > 0,
    );
    const pathCounts = new Map<string, number>();
    for (const row of level.rows) {
      const path = rowPathOf(row);
      pathCounts.set(path, (pathCounts.get(path) ?? 0) + 1);
    }
    const unreachable = new Set<string>();
    for (const row of toRead) {
      const path = rowPathOf(row);
      if (pathCounts.get(path) !== 1 || rowNameOf(row, path).includes(".")) unreachable.add(path);
    }
    if (toRead.length - unreachable.size > MAX_SPLIT) {
      return absorb(anchor, await read(anchor.path, MAX_DEPTH, NO_LIMIT), true);
    }
    if (unreachable.size === 0) return absorb(anchor, level, true);

    // Their children can only be read from here, but the rest can still be read on their own.
    const below = (path: string) => {
      for (let end = path.lastIndexOf("."); end > 0; end = path.lastIndexOf(".", end - 1)) {
        if (unreachable.has(path.slice(0, end))) return true;
      }
      return false;
    };
    let depth = state.plans.get(anchor.path)?.sharedPathDepth ?? SHARED_PATH_DEPTHS[0];
    let deep = await read(anchor.path, depth, NO_LIMIT);
    while (
      depth < MAX_DEPTH &&
      deep.rows.some((row) => below(rowPathOf(row)) && hiddenChildrenOf(row) > 0)
    ) {
      depth = SHARED_PATH_DEPTHS.find((next) => next > depth) ?? MAX_DEPTH;
      deep = await read(anchor.path, depth, NO_LIMIT);
    }
    const rows = [...level.rows, ...deep.rows.filter((row) => below(rowPathOf(row)))];
    return absorb(
      anchor,
      { rows, truncated: deep.truncated, hash: hashOf(JSON.stringify(rows)) },
      true,
      depth,
    );
  };

  await new Promise<void>((resolve) => {
    let next = 0;
    let running = 0;
    const drain = () => {
      while (running < CONCURRENT_READS && next < queue.length && !signal?.aborted) {
        const anchor = queue[next++];
        running += 1;
        visit(anchor)
          .catch((error) => {
            complete = false;
            // Removed since its parent was read. The next sync sees the parent without it.
            if (!(error instanceof ObjectGone)) firstError ??= error;
          })
          .finally(() => {
            running -= 1;
            drain();
          });
      }
      if (running === 0) resolve();
    };
    drain();
  });

  if (signal?.aborted) complete = false;
  for (const path of state.plans.keys()) {
    if (!seen.has(path) && complete) state.plans.delete(path);
  }
  state.model = model;
  state.rootHash = rootHash;
  state.treeVersion = history.treeVersion;
  state.complete = complete;
  state.readAt = Date.now();
  if (firstError) throw firstError;
  return { changed, watching, complete, truncated, slowestReadMs };
}
