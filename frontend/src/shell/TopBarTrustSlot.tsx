import React from 'react';

/**
 * Slot in the top bar for the model-trust indicator (<ModelTrustPill/>, built in ui/badges/ by the design-tools work).
 * Deliberately import-free: AppShell passes the pill as children once it exists; until then nothing renders here.
 */
export const TopBarTrustSlot: React.FC<{ children?: React.ReactNode }> = ({ children }) =>
  children ? <div className="uos-trust-slot" data-slot="model-trust">{children}</div> : null;
