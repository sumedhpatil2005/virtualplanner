import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditingEngine } from '../editing/EditingEngine';
import { ObjectManager } from '../objects/ObjectManager';
import { HistoryManager } from '../history/HistoryManager';
import { LocalOsmIndex } from '../editing/LocalOsmIndex';
import { areaFromBoundary, buildingRing, geometryTouchesArea } from '../editing/studyAreaImport';
import { TrafficSignalSource } from '../simulation/trafficSignals';

const area = areaFromBoundary('test-area', 'Test area', [[73.8,18.5,0],[73.81,18.5,0],[73.81,18.51,0],[73.8,18.51,0]]);
const geom = (points: number[][]) => points.map(([lon,lat]) => ({lon,lat}));
const way = (id: number, tags = { highway: 'residential' }) => ({type:'way',id,tags,geometry:geom([[73.805,18.505],[73.806,18.505]])});
const building = (id: number) => ({type:'way',id,tags:{building:'yes'},geometry:geom([[73.802,18.502],[73.803,18.502],[73.803,18.503],[73.802,18.502]])});
function setup() {
  vi.spyOn(EditingEngine.prototype, 'fetchSavedAreas').mockResolvedValue();
  const om = new ObjectManager();
  const local = new LocalOsmIndex();
  vi.spyOn(local,'supports').mockResolvedValue(false);
  const history = new HistoryManager(om);
  const editing = new EditingEngine(om,history,undefined,local);
  const fetch = vi.spyOn(editing as any, 'fetchAreaElements');
  const save = vi.spyOn(om,'addMultipleAndSave').mockImplementation(async objects => { om.addMultiple(objects,true); });
  vi.spyOn(om,'syncPost').mockResolvedValue(); vi.spyOn(om,'syncDelete').mockResolvedValue();
  return {om,local,history,editing,fetch,save};
}
afterEach(() => vi.restoreAllMocks());

describe('polygon geometry and source identity', () => {
  it('assembles reversed outer fragments but refuses incomplete, ambiguous and courtyard footprints', () => {
    const relation = {type:'relation', members:[{type:'way',role:'outer',geometry:geom([[0,0],[1,0],[1,1]])},{type:'way',role:'outer',geometry:geom([[0,0],[0,1],[1,1]])}]};
    expect(buildingRing(relation)).toEqual([[0,0,0],[1,0,0],[1,1,0],[0,1,0],[0,0,0]]);
    expect(buildingRing({...relation,members:relation.members.slice(0,1)})).toBeNull();
    expect(buildingRing({...relation,members:[...relation.members,{role:'inner'}]})).toBeNull();
    expect(buildingRing({type:'way',geometry:geom([[0,0],[1,0],[1,1]])})).toBeNull();
  });
  it('keeps complete crossing roads with no vertex inside and excludes bbox-only false positives', () => {
    expect(geometryTouchesArea([[73.79,18.505],[73.82,18.505]],area)).toBe(true);
    const triangle=areaFromBoundary('triangle','',[[0,0,0],[1,0,0],[0,1,0]]);
    expect(geometryTouchesArea([[0.8,0.8],[0.9,0.9]],triangle)).toBe(false);
  });
  it('does not conflate way and relation IDs', async () => {
    const {editing,fetch,om}=setup();
    const footprint=building(7);
    fetch.mockResolvedValue([footprint,{type:'relation',id:7,tags:{building:'yes'},members:[{type:'way',role:'outer',geometry:footprint.geometry}]}]);
    const report=await editing.importStudyArea(area,'base',['buildings']);
    expect(report.completed).toBe(true);
    expect(om.getById('osm_b_way_7')).toBeDefined();
    expect(om.getById('osm_b_relation_7')).toBeDefined();
  });
});

describe('unified import durability, recovery and editing protections', () => {
  it('imports roads, buildings, metro and stations together and filters signals to the polygon', async () => {
    const { editing, fetch, om } = setup();
    fetch.mockImplementation(async (_a, category) => category === 'roads' ? [way(1)] : category === 'buildings' ? [building(2)] : [
      { ...way(3), tags: { railway: 'subway', tunnel: 'yes' } },
      { type: 'node', id: 3, lon: 73.805, lat: 18.505, tags: { railway: 'station', station: 'subway' } },
    ]);
    vi.spyOn(TrafficSignalSource.prototype, 'signalsIn').mockResolvedValue([[73.805, 18.505], [74, 19]]);
    const report = await editing.importStudyArea(area, 'base', ['roads', 'buildings', 'metro', 'signals']);
    expect(report.completed).toBe(true);
    expect(om.getAll().map(o => o.type).sort()).toEqual(['building', 'metro_line', 'metro_station', 'road']);
    expect(report.categories.at(-1)?.added).toBe(1);
    expect(om.getById('osm_m_way_3')).toBeDefined(); expect(om.getById('osm_m_node_3')).toBeDefined();
  });
  it('waits for saving and preserves edits on repeated imports', async () => {
    const {editing,fetch,save,om}=setup(); fetch.mockResolvedValue([way(1)]);
    let finish!: () => void;
    save.mockImplementationOnce(objects => {om.addMultiple(objects,true); return new Promise(resolve => {finish=resolve;});});
    const promise=editing.importStudyArea(area,'base',['roads']);
    await vi.waitFor(() => expect(editing.studyAreaImportProgress?.phase).toBe('saving'));
    expect(editing.getIsImporting()).toBe(true); expect(editing.studyAreaImportReport?.completed).toBe(false);
    finish(); expect((await promise).completed).toBe(true);
    om.update('osm_1',{name:'Manually changed'});
    const retry=await editing.importStudyArea(area,'base',['roads']);
    expect(retry.categories[0]).toMatchObject({added:0,preserved:1});
    expect(om.getById('osm_1')?.name).toBe('Manually changed');
  });
  it('reports category failure and retries an in-memory failed save without overwriting a manual edit', async () => {
    const {editing,fetch,save,om}=setup(); fetch.mockImplementation(async (_a,_c) => _c==='roads'?[way(1)]:[building(2)]);
    save.mockImplementationOnce(async objects => {om.addMultiple(objects,true); throw new Error('save offline');});
    const partial=await editing.importStudyArea(area,'base',['roads','buildings']);
    expect(partial.completed).toBe(false); expect(partial.categories[0].error).toBe('save offline'); expect(partial.categories[1].added).toBe(1);
    om.update('osm_1',{name:'Keep edit after failure'});
    const retry=await editing.importStudyArea(area,'base',['roads']);
    expect(retry.completed).toBe(true); expect(save.mock.calls.at(-1)?.[0][0].name).toBe('Keep edit after failure');
  });
  it('cancels before the next category while keeping earlier completed saves', async () => {
    const {editing,fetch,save,om}=setup(); fetch.mockResolvedValue([way(1)]);
    save.mockImplementation(async objects => {om.addMultiple(objects,true); editing.cancelImport();});
    const report=await editing.importStudyArea(area,'base',['roads','buildings']);
    expect(report.cancelled).toBe(true); expect(report.completed).toBe(false); expect(report.categories[0].added).toBe(1); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('uses supported local categories and falls back for old indexes', async () => {
    const {editing,local,fetch}=setup(); vi.mocked(local.supports).mockImplementation(async category=>category==='roads');
    vi.spyOn(local,'ways').mockResolvedValue([way(1)]); fetch.mockResolvedValue([building(2)]);
    const report=await editing.importStudyArea(area,'base',['roads','buildings']);
    expect(report.categories.map(c=>c.source)).toEqual(['local','Overpass']); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('counts incomplete multipolygons as skipped rather than fabricating a footprint', async () => {
    const {editing,fetch,om}=setup(); fetch.mockResolvedValue([{type:'relation',id:1,tags:{building:'yes'},members:[{type:'way',role:'outer',geometry:geom([[73.802,18.502],[73.803,18.502],[73.803,18.503]])}]}]);
    const report=await editing.importStudyArea(area,'base',['buildings']);
    expect(report.categories[0]).toMatchObject({added:0,skipped:1}); expect(om.getAll()).toHaveLength(0);
  });
  it('skips deleted source objects', async () => {
    const {editing,fetch,om}=setup(); vi.spyOn(om,'deletedOsmIds').mockResolvedValue(new Set(['osm_1']));fetch.mockResolvedValue([way(1)]);
    expect((await editing.importStudyArea(area,'base',['roads'])).categories[0]).toMatchObject({added:0,preserved:1});
  });
});

describe('junction placement connections', () => {
  it('splits and links same-level approaches in one undo step, leaving a raised crossing untouched', async () => {
    const {editing,fetch,om,history}=setup(); fetch.mockResolvedValue([way(1),{...way(2),geometry:geom([[73.8055,18.504],[73.8055,18.506]])}]);
    await editing.importStudyArea(area,'base',['roads']);
    om.add({...om.getById('osm_1')!,id:'upper',coordinates:[[73.805,18.505,12],[73.806,18.505,12]]} as any,true);
    editing.setMode('draw_junction'); editing.addDrawingPoint([73.8055,18.505,0]); editing.finalizeDrawing('base');
    const junction=om.getAll().find(o=>o.type==='junction')!;
    expect((junction as any).connectedRoads.sort()).toEqual(['osm_1','osm_2']);
    expect(om.getById('osm_1')?.coordinates).toHaveLength(3); expect(om.getById('upper')?.coordinates).toHaveLength(2);
    expect((om.getById('osm_1') as any).connectedJunctions).toContain(junction.id);
    history.undo(); expect(om.getById(junction.id)).toBeUndefined();expect(om.getById('osm_1')?.coordinates).toHaveLength(2);
    history.redo(); expect(om.getById(junction.id)).toBeDefined();
  });
  it('rejects an isolated placement', () => {
    const {editing}=setup(); editing.setMode('draw_junction'); editing.addDrawingPoint([73.805,18.505,0]);
    expect(()=>editing.finalizeDrawing('base')).toThrow(/two road approaches/);
  });
});
