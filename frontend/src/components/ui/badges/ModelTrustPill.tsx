import React, { useState } from 'react';
import { OctagonX } from 'lucide-react';
import { ValidationSummary } from './ValidationSummary';
import { AnchoredPopover } from '../AnchoredPopover';

/** Top-bar pill (UX_ARCHITECTURE §2): always visible, opens the recorded validation results. */
export const ModelTrustPill: React.FC<{ className?: string }> = ({ className = '' }) => {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" ref={setAnchor} data-testid="model-trust-pill" aria-haspopup="dialog" aria-expanded={open}
        onClick={() => setOpen(o => !o)}
        className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 h-7 text-[12px] font-semibold whitespace-nowrap cursor-pointer ${className}`}
        style={{ color: 'var(--fail, #FF6B61)', borderColor: 'var(--fail, #FF6B61)', background: 'color-mix(in srgb, var(--fail, #FF6B61) 14%, transparent)' }}>
        <OctagonX size={13} aria-hidden="true" />
        Traffic model fails validation
      </button>
      <AnchoredPopover anchor={anchor} open={open} onClose={() => setOpen(false)} placement="below" width={360} label="Traffic model validation summary" testId="model-trust-popover">
        <ValidationSummary />
      </AnchoredPopover>
    </>
  );
};
