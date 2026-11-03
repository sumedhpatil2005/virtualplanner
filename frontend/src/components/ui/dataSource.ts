/** Kinds of data source a displayed value can have (see SourceBadge). */
export type DataSource = 'observed' | 'survey' | 'estimated' | 'synthetic' | 'calibrated' | 'simulated' | 'hypothetical';

/** Maps provenance values used across the project onto badge kinds. */
export function sourceOf(provenance: string | undefined | null): DataSource {
  switch (provenance) {
    case 'observed': return 'observed';
    case 'survey': return 'survey';
    case 'synthetic': return 'synthetic';
    case 'calibrated': return 'calibrated';
    case 'hypothetical': return 'hypothetical';
    default: return 'estimated'; // 'estimated', 'project-estimate', missing
  }
}
