import { describe, it, expect } from 'vitest';
import { isSampleObject } from '../objects/sampleObjects';

describe('sample objects are kept out of Simulate', () => {
  it('matches the seeded demo objects by id and name together', () => {
    expect(isSampleObject({ id: 'r1', name: 'Pune Central Boulevard' })).toBe(true);
    expect(isSampleObject({ id: 'j1', name: 'Boulevard Intersection' })).toBe(true);
    // A real road, or a sample the user renamed (adopted), is not a sample
    expect(isSampleObject({ id: 'osm_22841323', name: 'Shivaji Bridge' })).toBe(false);
    expect(isSampleObject({ id: 'r1', name: 'My new road' })).toBe(false);
  });
});
