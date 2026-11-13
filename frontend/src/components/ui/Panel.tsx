import React from 'react';
import { X } from 'lucide-react';
import { IconButton } from './IconButton';

/**
 * Flat, bordered panel for the shell's context panel, inspector and drawer content (tokens: surface-1, border).
 * Header: title, optional one-line subtitle, actions, close. Body scrolls. A footer is only for real actions.
 */
export const Panel: React.FC<{
  title: string;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  onClose?: () => void;
  closeLabel?: string;
  footer?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  'aria-label'?: string;
}> = ({ title, subtitle, actions, onClose, closeLabel = 'Close panel', footer, children, className = '', ...rest }) => (
  <section className={`uos-panel ${className}`} aria-label={rest['aria-label'] ?? title}>
    <header className="uos-panel-header">
      <div className="min-w-0 flex-1">
        <h2 className="text-heading font-semibold text-text-1 truncate">{title}</h2>
        {subtitle && <div className="text-meta text-text-2 mt-0.5">{subtitle}</div>}
      </div>
      {actions}
      {onClose && <IconButton icon={X} label={closeLabel} onClick={onClose} size="sm" tooltip="left" />}
    </header>
    <div className="uos-panel-body">{children}</div>
    {footer && <footer className="uos-panel-footer">{footer}</footer>}
  </section>
);

/** A titled block inside a Panel body. */
export const PanelSection: React.FC<{ title?: string; aside?: React.ReactNode; children: React.ReactNode }> = ({ title, aside, children }) => (
  <section className="space-y-2">
    {(title || aside) && (
      <div className="flex items-baseline justify-between gap-2">
        {title && <h3 className="text-label font-semibold text-text-2">{title}</h3>}
        {aside && <span className="text-meta text-text-3">{aside}</span>}
      </div>
    )}
    {children}
  </section>
);
