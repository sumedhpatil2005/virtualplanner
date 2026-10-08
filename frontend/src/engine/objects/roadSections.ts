import type { RoadObject, RoadSectionProfile } from './types';

type Point = readonly number[];

/** Sections own segments [start, end); neighbouring profiles share a vertex. */
export function hasCompleteSectionCoverage(sections: readonly RoadSectionProfile[], vertexCount: number): boolean {
  if (sections.length === 0) return false;
  let end = 0;
  for (const section of sections) {
    if (!Number.isInteger(section.startNodeIndex) || !Number.isInteger(section.endNodeIndex) ||
      section.startNodeIndex !== end || section.endNodeIndex < end ||
      (vertexCount > 1 && section.endNodeIndex === end)) return false;
    end = section.endNodeIndex;
  }
  return end === Math.max(0, vertexCount - 1);
}

/**
 * Keep supplied profiles, fill gaps with the preceding profile (the first
 * profile fills a leading gap), and clip overlaps at the next profile's start.
 * No geometry, source coordinates or provenance is modified by this repair.
 */
export function normalizeRoadSections(sections: readonly RoadSectionProfile[], vertexCount: number): RoadSectionProfile[] {
  if (hasCompleteSectionCoverage(sections, vertexCount)) return sections as RoadSectionProfile[];
  const last = Math.max(0, vertexCount - 1);
  const candidates = sections.filter(section =>
    Number.isFinite(section.startNodeIndex) && Number.isFinite(section.endNodeIndex) &&
    section.endNodeIndex >= section.startNodeIndex && (last === 0 || section.startNodeIndex < last)
  ).map(section => ({ ...section, startNodeIndex: Math.max(0, Math.floor(section.startNodeIndex)) }))
    .sort((a, b) => a.startNodeIndex - b.startNodeIndex);
  if (candidates.length === 0) return [];
  const unique: RoadSectionProfile[] = [];
  for (const section of candidates) {
    if (unique.at(-1)?.startNodeIndex === section.startNodeIndex) unique[unique.length - 1] = section;
    else unique.push(section);
  }
  return unique.map((section, index) => ({
    ...section,
    startNodeIndex: index === 0 ? 0 : section.startNodeIndex,
    endNodeIndex: unique[index + 1]?.startNodeIndex ?? last,
  }));
}

const sameXY = (a: Point, b: Point) => a[0] === b[0] && a[1] === b[1];

/** Exact ordered correspondence for densified roads, including repeated points. */
export function retainedVertexIndices(before: readonly Point[], after: readonly Point[]): number[] | undefined {
  const result: number[] = [];
  let cursor = 0;
  for (const point of before) {
    while (cursor < after.length && !sameXY(point, after[cursor])) cursor++;
    if (cursor === after.length) return undefined;
    result.push(cursor++);
  }
  return result;
}

/** Map profile boundaries through insertions/deletions; a moved vertex keeps its index. */
export function remapRoadSections(
  sections: readonly RoadSectionProfile[], before: readonly Point[], after: readonly Point[], originalIndices?: readonly number[],
): RoadSectionProfile[] {
  const normalized = normalizeRoadSections(sections, before.length);
  if (before.length === after.length && !originalIndices) return normalizeRoadSections(normalized, after.length);
  let indices = originalIndices ?? retainedVertexIndices(before, after);
  if (!indices) {
    // Deleted vertices: anchor every surviving point, then interpolate missing
    // boundary indices between those anchors. This also handles a reshape.
    const positions = new Map<string, number[]>();
    after.forEach((point, index) => {
      const key = `${point[0]},${point[1]}`;
      const values = positions.get(key) ?? [];
      values.push(index);
      positions.set(key, values);
    });
    const anchors: [number, number][] = [[0, 0]];
    let cursor = 0;
    before.forEach((point, index) => {
      const matches = positions.get(`${point[0]},${point[1]}`);
      const match = matches?.find(value => value >= cursor);
      if (match !== undefined) {
        anchors.push([index, match]);
        cursor = match + 1;
      }
    });
    anchors.push([Math.max(0, before.length - 1), Math.max(0, after.length - 1)]);
    const mapped: number[] = [];
    let anchor = 0;
    for (let index = 0; index < before.length; index++) {
      while (anchor + 1 < anchors.length - 1 && anchors[anchor + 1][0] <= index) anchor++;
      const [a, b] = [anchors[anchor], anchors[anchor + 1]];
      mapped.push(a[0] === b[0] ? b[1] : Math.round(a[1] + (b[1] - a[1]) * (index - a[0]) / (b[0] - a[0])));
    }
    indices = mapped;
  }
  return normalizeRoadSections(normalized.map(section => ({
    ...section,
    startNodeIndex: indices[section.startNodeIndex] ?? 0,
    endNodeIndex: indices[section.endNodeIndex] ?? Math.max(0, after.length - 1),
  })), after.length);
}

/** Recover old bridge indices only when the original geometry proves the mapping. */
export function repairRoadSections(road: RoadObject): RoadSectionProfile[] {
  const sections = road.sections ?? [];
  if (hasCompleteSectionCoverage(sections, road.coordinates.length)) return sections;
  if (road.sourceCoordinates && hasCompleteSectionCoverage(sections, road.sourceCoordinates.length) &&
    !sections.some(section => section.provenance?.geometryModified)) {
    const indices = retainedVertexIndices(road.sourceCoordinates, road.coordinates);
    if (indices) return remapRoadSections(sections, road.sourceCoordinates, road.coordinates, indices);
  }
  return normalizeRoadSections(sections, road.coordinates.length);
}
