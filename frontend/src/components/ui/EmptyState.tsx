import React from 'react';
import type { LucideIcon } from 'lucide-react';

/**
 * Icon + one sentence + at most one REAL action (PRODUCT_UX_RESEARCH §5.5). Used for capability gaps
 * ("No groundwater data imported") instead of empty maps or fake controls. Omit `action` when nothing real exists.
 */
export const EmptyState: React.FC<{
  icon: LucideIcon;
  title: string;
  children?: React.ReactNode;
  action?: { label: string; onClick: () => void; 'data-testid'?: string };
}> = ({ icon: Icon, title, children, action }) => (
  <div className="uos-empty" role="status">
    <Icon size={20} aria-hidden className="text-text-3 shrink-0" />
    <div className="min-w-0 space-y-1">
      <p className="text-body font-medium text-text-1">{title}</p>
      {children && <div className="text-label text-text-2">{children}</div>}
      {action && (
        <button type="button" onClick={action.onClick} data-testid={action['data-testid']} className="uos-btn uos-btn-sm mt-1">
          {action.label}
        </button>
      )}
    </div>
  </div>
);
