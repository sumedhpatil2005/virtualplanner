/**
 * Fastest routes on a directed graph, as one shortest-path tree per
 * destination: every node's travel time to the destination and the link to
 * take next. One tree (a reverse Dijkstra run) answers routes to its
 * destination from everywhere, so thousands of trips to a few hundred exits
 * cost a few hundred searches rather than one each.
 *
 * Nodes and links are numbered; the graph is held in typed arrays.
 */

export interface RouteTree {
  /** Travel time from each node to the destination (Infinity where it cannot be reached). */
  time: Float64Array;
  /** Link to take next from each node (-1 at the destination or where unreachable). */
  next: Int32Array;
}

export class RouteTrees {
  private readonly nodeCount: number;
  private readonly linkFrom: Int32Array;
  private readonly linkTo: Int32Array;
  private readonly linkCost: Float64Array;
  private readonly inStart: Int32Array;
  private readonly inLinks: Int32Array;
  private readonly trees = new Map<number, RouteTree>();

  constructor(nodeCount: number, linkFrom: Int32Array, linkTo: Int32Array, linkCost: Float64Array) {
    this.nodeCount = nodeCount;
    this.linkFrom = linkFrom;
    this.linkTo = linkTo;
    this.linkCost = linkCost;
    // Links into each node, in compressed rows
    const count = new Int32Array(nodeCount + 1);
    for (let l = 0; l < linkTo.length; l++) count[linkTo[l] + 1]++;
    for (let n = 0; n < nodeCount; n++) count[n + 1] += count[n];
    this.inStart = count.slice();
    this.inLinks = new Int32Array(linkTo.length);
    const fill = count.slice(0, nodeCount);
    for (let l = 0; l < linkTo.length; l++) this.inLinks[fill[linkTo[l]]++] = l;
  }

  /** The tree of routes to `target` (worked out once, then kept). */
  public treeTo(target: number): RouteTree {
    let tree = this.trees.get(target);
    if (tree) return tree;
    const time = new Float64Array(this.nodeCount).fill(Infinity);
    const next = new Int32Array(this.nodeCount).fill(-1);
    const done = new Uint8Array(this.nodeCount);
    const heap = new NodeHeap();
    time[target] = 0;
    heap.push(target, 0);
    while (heap.size > 0) {
      const node = heap.popNode();
      if (done[node]) continue;
      done[node] = 1;
      const t = time[node];
      for (let k = this.inStart[node]; k < this.inStart[node + 1]; k++) {
        const link = this.inLinks[k];
        const from = this.linkFrom[link];
        const via = t + this.linkCost[link];
        if (via < time[from]) {
          time[from] = via;
          next[from] = link;
          heap.push(from, via);
        }
      }
    }
    tree = { time, next };
    this.trees.set(target, tree);
    return tree;
  }

  /** Fastest travel time between two nodes (Infinity when there is no route). */
  public timeBetween(from: number, to: number): number {
    return this.treeTo(to).time[from];
  }

  /** Links of the fastest route, or null when there is none ([] when from = to). */
  public path(from: number, to: number): number[] | null {
    const { time, next } = this.treeTo(to);
    if (time[from] === Infinity) return null;
    const out: number[] = [];
    for (let node = from; node !== to; node = this.linkTo[next[node]]) out.push(next[node]);
    return out;
  }
}

/** Binary min-heap of (node, key) pairs; a node may be pushed again with a smaller key. */
class NodeHeap {
  private nodes = new Int32Array(1024);
  private keys = new Float64Array(1024);
  public size = 0;

  push(node: number, key: number) {
    if (this.size === this.nodes.length) {
      const nodes = new Int32Array(this.size * 2);
      const keys = new Float64Array(this.size * 2);
      nodes.set(this.nodes);
      keys.set(this.keys);
      this.nodes = nodes;
      this.keys = keys;
    }
    let i = this.size++;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.keys[parent] <= key) break;
      this.nodes[i] = this.nodes[parent];
      this.keys[i] = this.keys[parent];
      i = parent;
    }
    this.nodes[i] = node;
    this.keys[i] = key;
  }

  popNode(): number {
    const top = this.nodes[0];
    const lastNode = this.nodes[--this.size];
    const lastKey = this.keys[this.size];
    let i = 0;
    for (;;) {
      let child = 2 * i + 1;
      if (child >= this.size) break;
      if (child + 1 < this.size && this.keys[child + 1] < this.keys[child]) child++;
      if (this.keys[child] >= lastKey) break;
      this.nodes[i] = this.nodes[child];
      this.keys[i] = this.keys[child];
      i = child;
    }
    this.nodes[i] = lastNode;
    this.keys[i] = lastKey;
    return top;
  }
}
