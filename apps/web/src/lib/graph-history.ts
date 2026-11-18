/**
 * The editor's single undo/redo history. Every change to the graph (add, delete, move, connect, disconnect, Clear,
 * paste, duplicate, a config edit, Tidy) pushes the graph as it was just before the change, so one Ctrl+Z steps back
 * over exactly one change whatever its kind.
 */

export interface GraphSnapshot<N, E> {
  nodes: N[];
  edges: E[];
}

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class GraphHistory<N, E> {
  private past: Array<GraphSnapshot<N, E>> = [];
  private future: Array<GraphSnapshot<N, E>> = [];

  constructor(private readonly limit = 50) {}

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  /** Records the graph as it is before a change. A new change ends any redo branch. */
  push(before: GraphSnapshot<N, E>): void {
    this.past.push(copy(before));
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
  }

  /** The graph to restore for one undo step, or null when there is none; `current` becomes the redo step. */
  undo(current: GraphSnapshot<N, E>): GraphSnapshot<N, E> | null {
    const previous = this.past.pop();
    if (!previous) return null;
    this.future.push(copy(current));
    return previous;
  }

  /** The graph to restore for one redo step, or null when there is none; `current` becomes an undo step again. */
  redo(current: GraphSnapshot<N, E>): GraphSnapshot<N, E> | null {
    const next = this.future.pop();
    if (!next) return null;
    this.past.push(copy(current));
    return next;
  }

  /** Forgets every step (another workflow was opened). */
  clear(): void {
    this.past = [];
    this.future = [];
  }
}

interface Positioned {
  id: string;
  position: { x: number; y: number };
}

/** Ids of nodes present in both lists whose position differs by half a pixel or more. */
export function movedNodeIds(before: readonly Positioned[], after: readonly Positioned[]): string[] {
  const start = new Map(before.map((node) => [node.id, node.position]));
  const moved: string[] = [];
  for (const node of after) {
    const origin = start.get(node.id);
    if (!origin) continue;
    if (Math.abs(origin.x - node.position.x) >= 0.5 || Math.abs(origin.y - node.position.y) >= 0.5) moved.push(node.id);
  }
  return moved;
}
