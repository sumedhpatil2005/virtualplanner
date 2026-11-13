import type { ConflictClass } from '../../lib/coordinationApi';

/** Result classes (COORDINATION_AND_SUBSURFACE §3), most severe first. Never shown as "clear". */
export const CLASS_ORDER: ConflictClass[] = ['conflict', 'potential_conflict', 'vertically_separated', 'no_conflict_within_available_data', 'unknown_no_coverage'];
export const CLASS_TEXT: Record<ConflictClass, { label: string; color: string; hint: string }> = {
  conflict: { label: 'Conflict', color: 'var(--fail, #ef4444)', hint: 'Footprints overlap (or are within a set clearance) and the vertical ranges overlap.' },
  potential_conflict: { label: 'Potential conflict', color: 'var(--warn, #f59e0b)', hint: 'Close in plan, but a depth or width is UNKNOWN, so it cannot be excluded.' },
  vertically_separated: { label: 'Vertically separated', color: 'var(--estimated, #38bdf8)', hint: 'Vertical gap between known ranges; adequacy is UNKNOWN unless a vertical clearance rule is set.' },
  no_conflict_within_available_data: { label: 'No conflict within available data', color: 'var(--text-2, #A9B3C1)', hint: 'Only what is in the covered datasets was checked. Not proof of no conflict.' },
  unknown_no_coverage: { label: 'Unknown — no data coverage', color: 'var(--unknown, #94a3b8)', hint: 'The layer has no data here (e.g. no utility records with a stated coverage). Not a pass.' },
};

