import { createHash } from "node:crypto";

import {
  type ExplorerNode,
  type ExplorerSyncResult,
  type ExplorerWait,
  sortExplorerNodes,
} from "../src/lib/explorer";
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
  truncated: boolean;
  readAt: number;
  plans: Map<string, Plan>;
}

const trees = new Map<string, TreeState>();

/** Forgets what's been read from Studio, for tests. */
export function resetExplorerTrees() {
  trees.clear();
}

class ObjectGone extends Error {}

/** Studio refused a read because of what it's doing, which stops the walk but isn't a failure. */
class StudioWaiting extends Error {
  constructor(readonly reason: ExplorerWait) {
    super(reason);
  }
}

/** What a refusal says about Studio's state. Null is anything else, which is a real failure. */
function waitIn(error: string): ExplorerWait | null {
  if (/studio_id\W* is not connected|No Roblox Studio instances are connected/i.test(error)) {
    return "studio_closed";
  }
  if (/Place is not open/i.test(error)) return "no_place";
  // A playtest starting or stopping: the data model is the wrong one, or isn't up yet.
  if (/not available in \w+ mode|Target is not reachable/i.test(error)) return "mode_changed";
  return null;
}

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
  signal?: AbortSignal,
): Promise<{ read: Read } | { error: string }> {
  const result = await callTool("search_game_tree", args, signal ? { signal } : undefined);
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
async function readRoot(
  callTool: CallStudioTool,
  studioId: string,
): Promise<{ model: string; rows: readonly any[] } | { waiting: ExplorerWait }> {
  const errors: Array<[string, string]> = [];
  for (const model of ["Edit", "Server", "Client"]) {
    const answer = await readTree(callTool, {
      studio_id: studioId,
      datamodel_type: model,
      max_depth: 1,
      head_limit: NO_LIMIT,
    });
    if ("read" in answer) return { model, rows: answer.read.rows };
    // This is about which Studio, not which data model, so the others would say the same.
    if (waitIn(answer.error) === "studio_closed") return { waiting: "studio_closed" };
    errors.push([model, answer.error]);
  }
  const waits = errors.map(([, error]) => waitIn(error));
  if (waits[0] && waits.every(Boolean)) return { waiting: waits[0] };
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

interface BuiltEntry {
  node: BuiltNode;
  rowPath: string;
  parentName: string;
  hidden: number;
  rowIndex: number;
}

// Rows at one path can still be different objects: a child called "A.B", and a "B" inside a child
// "A". A path can't tell them apart, but names and parents can.
const rowKey = (path: string, name: string) => `${path}\0${name}`;

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
  const byKey = new Map<string, BuiltEntry[]>();
  const rowsAtPath = new Map<string, number>();
  const keyAtPath = new Map<string, string>();
  for (const [rowIndex, row] of rows.entries()) {
    const path = rowPathOf(row);
    if (!path) continue;
    const name = rowNameOf(row, path);
    const key = rowKey(path, name);
    const entry = {
      rowIndex,
      rowPath: path,
      parentName: typeof row?.parentName === "string" ? row.parentName : "",
      hidden: hiddenChildrenOf(row),
      node: {
        name,
        className: typeof row?.className === "string" ? row.className : "Instance",
        path: gamePath(path),
        hasChildren: false,
        children: [],
      },
    };
    const entries = byKey.get(key);
    if (entries) entries.push(entry);
    else byKey.set(key, [entry]);
    rowsAtPath.set(path, (rowsAtPath.get(path) ?? 0) + 1);
    if (!keyAtPath.has(path)) keyAtPath.set(path, key);
  }

  const anchorKey = keyAtPath.get(anchor.path) ?? "";
  const levels = new Map<string, number>([[anchorKey, 0]]);
  const reachable = new Map<string, boolean>([[anchorKey, true]]);
  const childKeys = new Map<string, string[]>();
  for (const [key, entries] of byKey) {
    if (key === anchorKey) continue;
    const { node, rowPath, parentName } = entries[0];
    const parentPath = parentPathOf(rowPath, node.name);
    const named = rowKey(parentPath, parentName);
    const parentKey = byKey.has(named) ? named : keyAtPath.get(parentPath);
    if (!parentKey) continue;
    const siblings = childKeys.get(parentKey);
    if (siblings) siblings.push(key);
    else childKeys.set(parentKey, [key]);
    // Parents come first, because of the order of the rows.
    levels.set(key, (levels.get(parentKey) ?? 0) + 1);
    // A path only reaches the first object with it, and a period in a name breaks it.
    reachable.set(
      key,
      (reachable.get(parentKey) ?? false) &&
        rowsAtPath.get(rowPath) === 1 &&
        !node.name.includes("."),
    );
    if (entries.length > 1) {
      entries.forEach((entry, occurrence) => {
        entry.node.occurrence = occurrence;
        entry.node.occurrences = entries.length;
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
  const link = async (parentKey: string, parents: readonly BuiltNode[]) => {
    const keys = childKeys.get(parentKey) ?? [];
    const rowsBelow = keys.flatMap((key) => byKey.get(key) ?? []);
    if (rowsBelow.length === 0) return;
    if (parents.length === 1) {
      parents[0].children = rowsBelow.map(({ node }) => node);
    } else {
      hasTwins = true;
      const counts = (await countsAt(levels.get(parentKey) ?? 0)).get(parentKey) ?? [];
      const children = rowsBelow.sort((a, b) => a.rowIndex - b.rowIndex).map(({ node }) => node);
      let next = 0;
      parents.forEach((parent, index) => {
        // Anything Studio didn't account for stays visible under the last one.
        const count = index === parents.length - 1 ? children.length - next : (counts[index] ?? 0);
        parent.children = children.slice(next, next + count);
        next += count;
      });
    }
    for (const key of keys) {
      await link(
        key,
        (byKey.get(key) ?? []).map(({ node }) => node),
      );
    }
  };
  await link(anchorKey, [top]);

  // Each id comes from its parent's, with a number for the ones after the first with a name.
  const identify = (nodes: readonly BuiltNode[], parentId: string) => {
    const used = new Map<string, number>();
    const taken = new Set<string>();
    for (const node of nodes) {
      let index = used.get(node.name) ?? 0;
      let id = `${parentId}${node.name}${index > 0 ? `#${index}` : ""}`;
      // A real name can look like a numbered one, as with "Foo#1" beside two called "Foo".
      while (taken.has(id)) {
        index += 1;
        id = `${parentId}${node.name}#${index}`;
      }
      used.set(node.name, index + 1);
      taken.add(id);
      node.id = id;
      node.hasChildren = node.children.length > 0;
      identify(node.children, `${node.id}.`);
    }
  };
  identify(top.children, `${anchor.id}.`);

  // What this read stopped short of. Nothing can reach below an object that shares a path, so those
  // don't offer an arrow that would do nothing.
  const frontier: Anchor[] = [];
  for (const [key, entries] of byKey) {
    if (!reachable.get(key) || key === anchorKey) continue;
    for (const { hidden, node, rowPath } of entries) {
      if (hidden <= 0 || node.children.length > 0 || !node.id) continue;
      node.hasChildren = true;
      node.pending = true;
      frontier.push({ path: rowPath, id: node.id });
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
          truncated: false,
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
  const waitingFor = (reason: ExplorerWait): ExplorerSyncResult => {
    state.complete = false;
    return {
      changed: false,
      watching: false,
      complete: false,
      truncated: false,
      slowestReadMs,
      waiting: reason,
    };
  };
  if ("waiting" in root) return waitingFor(root.waiting);
  const { model } = root;
  const services = root.rows.filter((row) => {
    const path = rowPathOf(row);
    return path && row?.className !== "DataModel" && VISIBLE_SERVICES.has(path.split(".")[0]);
  });
  const placeName =
    root.rows.find((row) => row?.className === "DataModel" && typeof row?.name === "string")?.name ||
    "Roblox Studio";
  // Every loaded place has these, so what's on screen stays until this one has them too.
  if (services.length === 0) return waitingFor("place_loading");
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
    return {
      changed: false,
      watching,
      complete: true,
      truncated: state.truncated,
      slowestReadMs,
    };
  }
  if (state.model !== model) state.plans.clear();

  let changed = false;
  let truncated = false;
  let complete = true;
  let nodeCount = services.length;
  let firstError: unknown = null;
  let waiting = null as ExplorerWait | null;
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
    // Another read may have just been refused, and this one was picked for the same data model.
    if (waiting) throw new StudioWaiting(waiting);
    const answer = await timed(() =>
      readTree(callTool, {
        studio_id: studioId,
        datamodel_type: model,
        path,
        max_depth: depth,
        head_limit: limit,
      }, signal),
    );
    if ("error" in answer) {
      const wait = waitIn(answer.error);
      throw wait ? new StudioWaiting(wait) : new Error(answer.error);
    }
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
              const key = rowKey(path, rowNameOf(row, path));
              const list = found.get(key);
              if (list) list.push(hiddenChildrenOf(row));
              else found.set(key, [hiddenChildrenOf(row)]);
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
      // The data model was chosen before this walk, so once Studio moves on the rest would be refused.
      while (running < CONCURRENT_READS && next < queue.length && !signal?.aborted && !waiting) {
        const anchor = queue[next++];
        running += 1;
        visit(anchor)
          .catch((error) => {
            complete = false;
            if (error instanceof StudioWaiting) {
              waiting ??= error.reason;
              return;
            }
            // Removed since its parent was read, the next sync sees the parent without it. And a read
            // that was cancelled has been replaced by a newer one.
            if (!(error instanceof ObjectGone) && !signal?.aborted) firstError ??= error;
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
  state.truncated = truncated;
  state.readAt = Date.now();
  // Reads that failed around a change of mode say nothing the next walk won't find out for itself.
  if (waiting) return { changed, watching, complete, truncated, slowestReadMs, waiting };
  if (firstError) throw firstError;
  return { changed, watching, complete, truncated, slowestReadMs };
}
