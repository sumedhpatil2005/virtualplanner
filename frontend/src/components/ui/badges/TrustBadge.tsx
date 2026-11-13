import React, { useState } from 'react';
import { OctagonX, TriangleAlert, CircleCheck } from 'lucide-react';
import { TRUST_COLOR, TRUST_HELP, TRUST_LABEL, type Trust } from './honesty';
import { TRAFFIC_VALIDATION } from './validationSummary';
import { ValidationSummary } from './ValidationSummary';
import { AnchoredPopover } from '../AnchoredPopover';

const ICON = { fails_validation: OctagonX, not_validated: TriangleAlert, stale: TriangleAlert, validated: CircleCheck } as const;

/**
 * Trust of a MODEL OUTPUT (PUX §5.7 axis 2). Not dismissable. For the traffic model the
 * default label is "Fails validation (TAG M3.1)" and the badge opens the recorded results.
 */
export const TrustBadge: React.FC<{ trust: Trust; label?: string; testId?: string; className?: string }> = ({ trust, label, testId = 'trust-badge', className = '' }) => {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const Icon = ICON[trust];
  const color = TRUST_COLOR[trust];
  const text = label ?? (trust === 'fails_validation' ? `${TRUST_LABEL[trust]} (${TRAFFIC_VALIDATION.standard})` : TRUST_LABEL[trust]);
  const cls = `inline-flex items-center gap-1 rounded border px-1.5 py-px text-[11px] font-semibold whitespace-nowrap ${className}`;
  const style = { color, borderColor: color, background: 'color-mix(in srgb, currentColor 12%, transparent)' };
  if (trust !== 'fails_validation') {
    return <span data-trust={trust} data-testid={testId} title={TRUST_HELP[trust]} className={cls} style={style}><Icon size={11} aria-hidden="true" />{text}</span>;
  }
  return (
    <>
      <button type="button" ref={setAnchor} data-trust={trust} data-testid={testId} title={`${TRUST_HELP[trust]} Click for the recorded results.`}
        aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(o => !o)} className={`${cls} cursor-pointer`} style={style}>
        <Icon size={11} aria-hidden="true" />{text}
      </button>
      <AnchoredPopover anchor={anchor} open={open} onClose={() => setOpen(false)} placement="below" width={340} label="Traffic model validation summary">
        <ValidationSummary />
      </AnchoredPopover>
    </>
  );
};
