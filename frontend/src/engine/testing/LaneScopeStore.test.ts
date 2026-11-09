import { describe, expect, it, vi } from 'vitest';

vi.mock('../TwinCityEngine', () => ({ engineInstance: { highlightRoads: () => {} } }));
import { getLaneEditScope, setLaneEditScope, subscribeLaneScope } from '../../components/laneScopeStore';

/**
 * The lane edit scope is held per road (docs/OVERHAUL.md §27.5). In the browser the first "This segment only" click
 * on a newly selected road was lost: the control reset one global scope in an effect keyed on the road, the effect
 * ran after the click and a segment-only lane edit changed the whole carriageway (Sangamwadi Bridge deck, 2 pieces).
 */
describe('lane edit scope store', () => {
  it('a choice holds for the road it was made on; any other road reads the default', () => {
    expect(getLaneEditScope('a')).toBe('carriageway');
    setLaneEditScope('a', 'segment');
    expect(getLaneEditScope('a')).toBe('segment');
    expect(getLaneEditScope('b')).toBe('carriageway');
  });
  it('choosing on another road resets the first to the default; nothing else resets a choice', () => {
    setLaneEditScope('a', 'segment');
    setLaneEditScope('b', 'segment');
    expect(getLaneEditScope('b')).toBe('segment');
    expect(getLaneEditScope('a')).toBe('carriageway');
  });
  it('notifies subscribers', () => {
    let n = 0; const off = subscribeLaneScope(() => n++);
    setLaneEditScope('c', 'carriageway'); off(); setLaneEditScope('c', 'segment');
    expect(n).toBe(1);
  });
});
