/**
 * A timestamp in words WITH its zone. The API sends either ISO-8601 or an already formatted local time with zone
 * ("Fri 2026-11-13 10:42 PM IST (UTC+05:30)"): the latter is shown as sent (re-parsing it is browser-dependent).
 */
export function formatWhen(iso: string | null | undefined, empty = '–'): string {
  if (!iso || !iso.trim()) return empty;
  if (!/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(iso.trim())) return iso.trim();
  const t = iso.trim();
  if (/\d{2}:\d{2}/.test(t) && !/(Z|[+-]\d{2}:?\d{2})$/.test(t)) return `${t.replace('T', ' ').replace(/\.\d+$/, '')} (zone not stated)`;
  const d = new Date(t.replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return iso.trim();
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
}
