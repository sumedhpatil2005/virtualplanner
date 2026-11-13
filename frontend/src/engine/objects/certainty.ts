/**
 * Certainty of a value (docs/urbanos/UX_ARCHITECTURE.md §4): measured | estimated | hypothetical | unknown.
 * Lives in the engine so object types can carry it; the UI badges re-export it.
 */
export type Certainty = 'measured' | 'estimated' | 'hypothetical' | 'unknown';
