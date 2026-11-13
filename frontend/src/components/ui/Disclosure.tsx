import React from 'react';
import { ChevronRight } from 'lucide-react';

/**
 * Collapsed-by-default "Technical details" block (PRODUCT_UX_RESEARCH §6: engineering detail lives under a
 * disclosure, not inline). Native <details>/<summary>, so it works without JS and is keyboard operable.
 * (ui/viz.tsx has an older `Disclosure` used inside Simulate; this one is the shell/design-system version.)
 */
export const Disclosure: React.FC<{ summary?: string; open?: boolean; children: React.ReactNode; 'data-testid'?: string }> = ({
  summary = 'Technical details', open, children, ...rest
}) => (
  <details className="uos-disclosure group" open={open} data-testid={rest['data-testid']}>
    <summary className="uos-disclosure-summary">
      <ChevronRight size={14} aria-hidden className="transition-transform group-open:rotate-90" />
      {summary}
    </summary>
    <div className="uos-disclosure-body">{children}</div>
  </details>
);
