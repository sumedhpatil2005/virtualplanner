import React, { useEffect, useState } from 'react';
import { FileText } from 'lucide-react';
import { infraApi, type TrafficCountsStatement } from '../../lib/infraApi';

/**
 * "Traffic counts: none from official sources — collection plan" (docs/urbanos/INFRASTRUCTURE_DATA.md §4). The statement
 * comes from GET /api/infra/traffic-counts; the link opens the repository's MISSING_DATA_AND_COLLECTION_PLAN.md as text.
 * No count is invented; the PMC portal item is shown as RESTRICTED (CAPTCHA).
 */
export const TrafficCountsNotice: React.FC<{ compact?: boolean }> = ({ compact }) => {
  const [st, setSt] = useState<TrafficCountsStatement | null>(null);
  useEffect(() => { let live = true; infraApi.trafficCounts().then(s => { if (live) setSt(s); }).catch(() => { /* static line below still shows */ }); return () => { live = false; }; }, []);
  return (
    <div className="rounded-md border border-border bg-surface-2 px-2.5 py-2 space-y-1" data-testid="traffic-counts-notice" role="note">
      <p className="text-label text-text-1">
        <span className="text-warn font-medium">Traffic counts: none from official sources</span>{' — '}
        <a className="uos-link inline-flex items-center gap-1" href={infraApi.docUrl('collection-plan')} target="_blank" rel="noreferrer" data-testid="traffic-counts-plan-link">
          <FileText size={12} aria-hidden />collection plan
        </a>
      </p>
      {!compact && st && <p className="text-meta text-text-3">{st.detail}</p>}
      {!compact && st?.restricted_sources.map(r => (
        <p key={r.id} className="text-meta text-text-3" data-testid="traffic-counts-restricted">{r.name}: <span className="text-warn">{r.access}</span>. {r.note}</p>
      ))}
    </div>
  );
};
