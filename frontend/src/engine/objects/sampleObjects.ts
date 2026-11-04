/**
 * The sample objects the app adds to an empty project (TwinCityEngine
 * loadSampleData): a fictional 1 km "Pune Central Boulevard", a side lane, a
 * signalised junction and two blocks, placed at 18.5204 N 73.8567 E, about
 * 230 m south of the real Shivaji Bridge. They are not part of the city, so
 * Simulate leaves them out: before this, the Shivaji Bridge study routed real
 * traffic over the fictional boulevard and traced its queue to the fictional
 * junction. They stay on the map (and in Build) until the user deletes them.
 *
 * Matched by id and name together, so a user object that reuses one of these
 * ids (or a sample the user renamed, i.e. adopted) still counts.
 */
export const SAMPLE_OBJECTS: Readonly<Record<string, string>> = {
  b1: 'TwinTowers Block A',
  b2: 'Cyber IT Park',
  r1: 'Pune Central Boulevard',
  r2: 'Tech Corridor Lane',
  j1: 'Boulevard Intersection',
};

export function isSampleObject(o: { id: string; name?: string }): boolean {
  return SAMPLE_OBJECTS[o.id] !== undefined && SAMPLE_OBJECTS[o.id] === o.name;
}
