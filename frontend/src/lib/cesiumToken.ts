/**
 * The Cesium ion access token from VITE_CESIUM_ION_TOKEN, or null when none
 * is configured. Placeholders copied from an example .env count as none, so
 * the viewer and the terrain switch agree on whether ion is available.
 */
const PLACEHOLDERS = new Set(['your_cesium_ion_token_here', 'your-token-here', 'changeme', 'undefined', 'null', 'none', 'token']);

export function normalizeIonToken(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.trim().replace(/^['"]|['"]$/g, '');
  if (!t) return null;
  if (PLACEHOLDERS.has(t.toLowerCase()) || /^<.*>$/.test(t) || /^your[_-]/i.test(t)) return null;
  return t;
}

export const cesiumIonToken = (): string | null => normalizeIonToken(import.meta.env.VITE_CESIUM_ION_TOKEN);
