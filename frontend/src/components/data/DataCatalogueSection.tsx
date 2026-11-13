import React, { useEffect, useState } from 'react';
import { Database, ListChecks, Loader2 } from 'lucide-react';
import { datasetsApi, type DsDataset, type FeatureStatus } from '../../lib/datasetsApi';
import { PanelSection } from '../ui/Panel';
import { catalogueSummary, withPendingVersions } from './dataCatalogueModel';
import { useDataCatalogue } from './useDataCatalogue';

/** Reports → "Data catalogue" entry: counts, and the two buttons that open the catalogue overlay. */
export const DataCatalogueSection: React.FC = () => {
  const show = useDataCatalogue(s => s.show);
  const [list, setList] = useState<DsDataset[] | null>(null);
  const [feat, setFeat] = useState<Record<FeatureStatus, number> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    datasetsApi.list().then(setList).catch((e: Error) => setErr(e.message));
    datasetsApi.features().then(r => setFeat(r.summary)).catch((e: Error) => setErr(e.message));
  }, []);
  const s = list ? catalogueSummary(list) : null;
  return (
    <PanelSection title="Data catalogue">
      {err && <p className="text-label text-warn" role="status">Registry not reachable ({err}).</p>}
      {!err && !s && <p className="text-label text-text-2 flex items-center gap-2"><Loader2 size={14} className="animate-spin" aria-hidden />Loading…</p>}
      {s && (
        <p className="text-label text-text-2 tabular-nums" data-testid="data-summary">
          {s.total} datasets: {s.available} available · {s.pending_review} pending review · {s.synthetic} synthetic · {s.not_acquired} not acquired
          {list && withPendingVersions(list) > 0 && <><br /><span data-testid="data-summary-pending-versions">{withPendingVersions(list)} in use with a newer version pending review</span></>}
          {feat && <><br />Features: {feat.ready} ready · {feat.partial} partial · {feat.blocked} blocked</>}
        </p>
      )}
      <div className="flex flex-wrap gap-1.5">
        <button type="button" className="uos-btn uos-btn-sm" onClick={() => show('datasets')} data-testid="open-data-catalogue"><Database size={14} aria-hidden />Datasets & provenance</button>
        <button type="button" className="uos-btn uos-btn-sm" onClick={() => show('features')} data-testid="open-feature-readiness"><ListChecks size={14} aria-hidden />Feature readiness</button>
      </div>
    </PanelSection>
  );
};
