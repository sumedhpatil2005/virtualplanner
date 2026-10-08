import { describe, it, expect } from 'vitest';
import { RouteTrees } from '../simulation/routeTrees';

/** Fastest routes from one shortest-path tree per destination. */

/** A graph from [from, to, cost] links. */
const graph = (nodes: number, links: [number, number, number][]) =>
  new RouteTrees(
    nodes,
    Int32Array.from(links, l => l[0]),
    Int32Array.from(links, l => l[1]),
    Float64Array.from(links, l => l[2]),
  );

describe('RouteTrees', () => {
  // 0 -> 1 -> 3 costs 2; 0 -> 2 -> 3 costs 5; 3 -> 4 one way; 5 is cut off
  const g = graph(6, [
    [0, 1, 1], [1, 3, 1],
    [0, 2, 1], [2, 3, 4],
    [3, 4, 1],
    [1, 0, 1],
  ]);

  it('finds the fastest route as a list of links', () => {
    expect(g.path(0, 3)).toEqual([0, 1]);
    expect(g.timeBetween(0, 4)).toBe(3);
    expect(g.path(2, 4)).toEqual([3, 4]);
  });

  it('respects one-way links and reports unreachable places', () => {
    expect(g.path(4, 0)).toBeNull();
    expect(g.timeBetween(5, 3)).toBe(Infinity);
    expect(g.path(1, 0)).toEqual([5]);
  });

  it('gives an empty route from a place to itself', () => {
    expect(g.path(3, 3)).toEqual([]);
  });

  it('agrees with a brute-force search on a random grid', () => {
    const n = 8;
    const id = (x: number, y: number) => y * n + x;
    const links: [number, number, number][] = [];
    let seed = 7;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        if (x + 1 < n) links.push([id(x, y), id(x + 1, y), 1 + rand() * 5], [id(x + 1, y), id(x, y), 1 + rand() * 5]);
        if (y + 1 < n) links.push([id(x, y), id(x, y + 1), 1 + rand() * 5], [id(x, y + 1), id(x, y), 1 + rand() * 5]);
      }
    }
    const trees = graph(n * n, links);
    // Bellman-Ford from every node to 0, as the reference
    const best = new Array(n * n).fill(Infinity);
    best[0] = 0;
    for (let k = 0; k < n * n; k++) for (const [a, b, c] of links) if (best[b] + c < best[a]) best[a] = best[b] + c;
    for (let v = 0; v < n * n; v++) {
      expect(trees.timeBetween(v, 0)).toBeCloseTo(best[v], 9);
      const route = trees.path(v, 0)!;
      expect(route.reduce((s, l) => s + links[l][2], 0)).toBeCloseTo(best[v], 9);
    }
  });
});
