import React from 'react';
import { TRAFFIC_VALIDATION } from './validationSummary';

/** Compact table of the recorded TAG M3.1 results (docs/ENGINEERING_VALIDATION.md §5.0). */
export const ValidationSummary: React.FC = () => (
  <div data-testid="validation-summary" className="flex flex-col gap-2">
    <p className="font-semibold" style={{ color: 'var(--fail, #FF6B61)' }}>Traffic model fails validation ({TRAFFIC_VALIDATION.standard})</p>
    <p style={{ color: 'var(--text-2, #A9B3C1)' }}>{TRAFFIC_VALIDATION.meaning}</p>
    <table className="w-full text-[11px]" style={{ fontVariantNumeric: 'tabular-nums' }}>
      <thead><tr style={{ color: 'var(--text-3, #8B95A3)' }} className="text-left"><th className="font-medium pb-1">Test</th><th className="font-medium pb-1">Needed</th><th className="font-medium pb-1">Result</th></tr></thead>
      <tbody>
        {TRAFFIC_VALIDATION.rows.map(r => (
          <tr key={r.test} data-status={r.status} className="align-top border-t" style={{ borderColor: 'var(--border, #333C47)' }}>
            <td className="py-1 pr-1">{r.test}</td>
            <td className="py-1 pr-1" style={{ color: 'var(--text-2, #A9B3C1)' }}>{r.required}</td>
            <td className="py-1"><span style={{ color: 'var(--fail, #FF6B61)' }} className="font-semibold">{r.status}</span> {r.result}</td>
          </tr>
        ))}
      </tbody>
    </table>
    <p style={{ color: 'var(--text-3, #8B95A3)' }}>
      Recorded in {TRAFFIC_VALIDATION.source} (code {TRAFFIC_VALIDATION.codeRef}). Criteria: <a href={TRAFFIC_VALIDATION.standardUrl} target="_blank" rel="noreferrer" className="underline">{TRAFFIC_VALIDATION.standardTitle}</a>.
    </p>
  </div>
);
