import { describe, expect, it } from 'vitest';
import { streamEntityId } from '../../components/environment/envDataModel';

/** The streams draw failed ("An entity with id env_overlay_dem_streams_null_0 already exists"): the server's features
 * carry their id in properties, not feature.id. Ids are unique per feature and part, with or without an id. */
describe('flow path entity ids', () => {
  it('are unique for features whose id is only in properties, or missing', () => {
    const feats = [{ properties: { id: 526 } }, { properties: { id: 412 } }, { properties: {} }, { properties: null }, { id: 7 }];
    const ids = feats.flatMap((f, k) => [0, 1].map(part => streamEntityId('dem_streams', f, k, part)));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe('env_overlay_dem_streams_0_526_0');
    expect(ids.some(i => i.includes('null'))).toBe(false);
    expect(ids.every(i => i.startsWith('env_overlay_'))).toBe(true);
  });
});
