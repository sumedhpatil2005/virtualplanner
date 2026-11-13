import React from 'react';
import { Database, CircleQuestionMark } from 'lucide-react';

export type DataStatusValue =
  | { status: 'available'; source: string; date: string; licence: string; url?: string }
  | { status: 'not_imported' };

/**
 * Whether a dataset is in the project. "Not imported" means its values are UNKNOWN, never a
 * pass or zero. 'available' requires source, date and licence; a missing one shows "unknown".
 */
export const DataStatus: React.FC<{ name: string; value: DataStatusValue; className?: string }> = ({ name, value, className = '' }) => {
  if (value.status === 'not_imported') {
    return (
      <span data-data-status="not_imported" className={`inline-flex items-center gap-1 text-[11px] ${className}`} style={{ color: 'var(--unknown, #9AA4B2)' }}
        title={`${name} has not been imported. Any check that needs it is UNKNOWN, not a pass.`}>
        <CircleQuestionMark size={11} aria-hidden="true" />
        <span className="font-semibold">Not imported</span> · UNKNOWN
      </span>
    );
  }
  const part = (v: string, what: string) => (v && v.trim() ? v : `${what} UNKNOWN`);
  return (
    <span data-data-status="available" className={`inline-flex flex-wrap items-center gap-1 text-[11px] ${className}`} style={{ color: 'var(--text-2, #A9B3C1)' }}>
      <Database size={11} aria-hidden="true" style={{ color: 'var(--measured, #3FB950)' }} />
      <span className="font-semibold" style={{ color: 'var(--text-1, #E6EAF0)' }}>Available</span>
      <span>· {value.url ? <a href={value.url} target="_blank" rel="noreferrer" className="underline">{part(value.source, 'source')}</a> : part(value.source, 'source')}</span>
      <span>· {part(value.date, 'date')}</span>
      <span>· licence {part(value.licence, '').trim()}</span>
    </span>
  );
};
