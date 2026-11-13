import React from 'react';
import { CircleCheck, CircleDashed, CircleQuestionMark, Sigma } from 'lucide-react';
import { CERTAINTY_COLOR, CERTAINTY_HELP, CERTAINTY_LABEL, type Certainty } from './honesty';

const ICON = { measured: CircleCheck, estimated: Sigma, hypothetical: CircleDashed, unknown: CircleQuestionMark } as const;

/**
 * Certainty of one VALUE (PUX §5.7 axis 1). Each level has its own icon shape so it reads
 * without colour. 'unknown' is a state, never a zero or a pass.
 */
export const CertaintyBadge: React.FC<{ certainty: Certainty; note?: string; compact?: boolean; className?: string }> = ({ certainty, note, compact, className = '' }) => {
  const Icon = ICON[certainty];
  const color = CERTAINTY_COLOR[certainty];
  return (
    <span data-certainty={certainty} title={note ? `${CERTAINTY_HELP[certainty]} ${note}` : CERTAINTY_HELP[certainty]}
      className={`inline-flex items-center gap-1 rounded border px-1.5 py-px text-[11px] font-semibold uppercase tracking-wide whitespace-nowrap ${className}`}
      style={{ color, borderColor: color, background: 'color-mix(in srgb, currentColor 12%, transparent)', borderStyle: certainty === 'hypothetical' ? 'dashed' : 'solid' }}>
      <Icon size={11} aria-hidden="true" />
      {compact ? null : CERTAINTY_LABEL[certainty]}
      {compact ? <span className="sr-only">{CERTAINTY_LABEL[certainty]}</span> : null}
    </span>
  );
};
