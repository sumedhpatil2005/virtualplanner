import type { TrafficNetwork } from '../objects/trafficTypes';

class MinHeap {
  private heap: { nodeId: string; score: number }[] = [];

  public isEmpty(): boolean {
    return this.heap.length === 0;
  }

  public insert(nodeId: string, score: number): void {
    this.heap.push({ nodeId, score });
    this.bubbleUp(this.heap.length - 1);
  }

  public extractMin(): { nodeId: string; score: number } | null {
    if (this.heap.length === 0) return null;
    const min = this.heap[0];
    const end = this.heap.pop()!;
    if (this.heap.length > 0) {
      this.heap[0] = end;
      this.bubbleDown(0);
    }
    return min;
  }

  private bubbleUp(idx: number): void {
    const element = this.heap[idx];
    while (idx > 0) {
      const parentIdx = Math.floor((idx - 1) / 2);
      const parent = this.heap[parentIdx];
      if (element.score >= parent.score) break;
      this.heap[idx] = parent;
      idx = parentIdx;
    }
    this.heap[idx] = element;
  }

  private bubbleDown(idx: number): void {
    const length = this.heap.length;
    const element = this.heap[idx];
    while (true) {
      const leftChildIdx = 2 * idx + 1;
      const rightChildIdx = 2 * idx + 2;
      let leftChild: { nodeId: string; score: number } | undefined;
      let rightChild: { nodeId: string; score: number } | undefined;
      let swapIdx: number | null = null;

      if (leftChildIdx < length) {
        leftChild = this.heap[leftChildIdx];
        if (leftChild.score < element.score) {
          swapIdx = leftChildIdx;
        }
      }

      if (rightChildIdx < length) {
        rightChild = this.heap[rightChildIdx];
        if (
          (swapIdx === null && rightChild.score < element.score) ||
          (swapIdx !== null && rightChild.score < leftChild!.score)
        ) {
          swapIdx = rightChildIdx;
        }
      }

      if (swapIdx === null) break;
      this.heap[idx] = this.heap[swapIdx];
      idx = swapIdx;
    }
    this.heap[idx] = element;
  }
}

export class Pathfinder {
  /**
   * Find the shortest route (list of edge IDs) between two nodes using Dijkstra's algorithm.
   * Travel time is used as the edge weight/cost.
   */
  public static findPath(
    network: TrafficNetwork,
    startNodeId: string,
    endNodeId: string
  ): string[] | null {
    if (!network.nodes.has(startNodeId) || !network.nodes.has(endNodeId)) {
      return null;
    }
    if (startNodeId === endNodeId) {
      return [];
    }

    const dist = new Map<string, number>(); // nodeId -> cost (travel time in seconds)
    const prev = new Map<string, { nodeId: string; edgeId: string }>(); // nodeId -> previous node & edge
    const visited = new Set<string>(); // Keep track of finalized nodes
    const heap = new MinHeap();

    dist.set(startNodeId, 0);
    heap.insert(startNodeId, 0);

    while (!heap.isEmpty()) {
      const min = heap.extractMin()!;
      const currNodeId = min.nodeId;
      const minDist = min.score;

      // Skip if we already found a shorter path to this node and finalized it
      if (visited.has(currNodeId)) continue;
      visited.add(currNodeId);

      if (currNodeId === endNodeId) {
        break;
      }

      const node = network.nodes.get(currNodeId)!;
      if (node.outgoingSegments) {
        node.outgoingSegments.forEach(edgeId => {
          const edge = network.edges.get(edgeId);
          if (!edge) return;

          const neighborId = edge.toNodeId;
          if (visited.has(neighborId)) return;

          // Cost = travel time in seconds = length (meters) / speed (m/s)
          const speedLimitMps = (edge.speedLimit || 50) / 3.6;
          const travelTime = edge.length / speedLimitMps;
          const currentNeighborDist = dist.has(neighborId) ? dist.get(neighborId)! : Infinity;
          const newDist = minDist + travelTime;

          if (newDist < currentNeighborDist) {
            dist.set(neighborId, newDist);
            prev.set(neighborId, { nodeId: currNodeId, edgeId });
            heap.insert(neighborId, newDist);
          }
        });
      }
    }

    if (!dist.has(endNodeId) || dist.get(endNodeId) === Infinity) {
      return null; // No path exists
    }

    // Reconstruct path
    const path: string[] = [];
    let curr = endNodeId;
    while (curr !== startNodeId) {
      const step = prev.get(curr);
      if (!step) break;
      path.push(step.edgeId);
      curr = step.nodeId;
    }

    return path.reverse();
  }
}
