import { afterEach, describe, expect, it, vi } from 'vitest';
import { ObjectManager } from '../objects/ObjectManager';
import type { CityObject } from '../objects/types';

/**
 * A create still in flight followed at once by an edit sent two POST /api/objects for one new id at the same time:
 * the server inserted both (the second a UNIQUE-constraint 500, "Unable to sync" toast). Each object's writes now go
 * one at a time, in order, and edits made while one is in flight are sent once, as the latest. Synthetic object.
 */

interface Call { method: string; url: string; body: any; release: (status?: number) => void }

function holdFetch() {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit) => new Promise(resolve => {
    calls.push({ method: init.method ?? 'GET', url, body: init.body ? JSON.parse(String(init.body)) : undefined,
      release: (status = 201) => resolve(new Response(status < 400 ? '{"status":"success"}' : 'error', { status })) });
  })));
  return calls;
}
const flush = () => new Promise(r => setTimeout(r, 0));
const alignment = (depth: number): CityObject => ({
  id: 'syn_align_1', type: 'underground_alignment', name: 'SYNTHETIC alignment', layerId: 'underground', scenarioId: 'base',
  coordinates: [[73.85, 18.52, 0], [73.86, 18.52, 0]], depthM: depth,
} as unknown as CityObject);

afterEach(() => { vi.unstubAllGlobals(); });

describe('object sync queue', () => {
  it('sends an edit made while the create is in flight after the create, never alongside it', async () => {
    const calls = holdFetch();
    const om = new ObjectManager();
    om.add(alignment(20));
    await flush();
    om.update('syn_align_1', { depthM: 25 } as any);
    await flush();
    expect(calls.length).toBe(1); // the edit waits for the create
    calls[0].release();
    await flush(); await flush();
    expect(calls.length).toBe(2);
    expect(calls[1].body.properties.depthM).toBe(25);
    calls[1].release();
    await flush(); await flush();
    expect(om.hasPendingWrite('syn_align_1')).toBe(false);
  });

  it('coalesces several edits made during one in-flight save into one request with the latest values', async () => {
    const calls = holdFetch();
    const om = new ObjectManager();
    om.add(alignment(20));
    await flush();
    for (const d of [21, 22, 23]) om.update('syn_align_1', { depthM: d } as any);
    await flush();
    calls[0].release();
    await flush(); await flush();
    calls[1]?.release();
    await flush(); await flush();
    expect(calls.map(c => c.body?.properties?.depthM)).toEqual([20, 23]);
  });

  it('a delete made while the create is in flight is sent after it, so the create cannot bring the object back', async () => {
    const calls = holdFetch();
    const om = new ObjectManager();
    (om as any).deletedOsm = new Set<string>();
    om.add(alignment(20));
    await flush();
    om.delete('syn_align_1');
    await flush();
    expect(calls.length).toBe(1);
    calls[0].release();
    await flush(); await flush();
    expect(calls[1].method).toBe('DELETE');
    calls[1].release();
    await flush(); await flush();
    expect(om.hasPendingWrite('syn_align_1')).toBe(false);
  });

  it('a failed save still lets the next edit go out, and the edit lands', async () => {
    const calls = holdFetch();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const om = new ObjectManager();
    om.add(alignment(20));
    await flush();
    om.update('syn_align_1', { depthM: 30 } as any);
    await flush();
    calls[0].release(500);
    await flush(); await flush();
    expect(calls.length).toBe(2);
    expect(calls[1].body.properties.depthM).toBe(30);
    calls[1].release();
    await flush(); await flush();
    expect(om.hasPendingWrite('syn_align_1')).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1); // the failed create only
    warn.mockRestore();
  });
});
