import React from 'react';
import type { LucideIcon } from 'lucide-react';

/**
 * Icon-only button with an always-present accessible name (aria-label) and a visible tooltip on hover and keyboard
 * focus (CSS only, .uos-tip in index.css). `label` is required: there is no unlabeled icon button.
 */
export const IconButton = React.forwardRef<HTMLButtonElement, {
  icon: LucideIcon;
  label: string;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  active?: boolean;
  /** Where the tooltip appears relative to the button. */
  tooltip?: 'top' | 'bottom' | 'left' | 'right';
  size?: 'sm' | 'md';
  disabled?: boolean;
  className?: string;
  'data-testid'?: string;
} & Pick<React.ButtonHTMLAttributes<HTMLButtonElement>, 'aria-expanded' | 'aria-pressed' | 'aria-controls' | 'aria-haspopup'>>(
  ({ icon: Icon, label, onClick, active, tooltip = 'bottom', size = 'md', disabled, className = '', ...rest }, ref) => (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      data-tip={tooltip}
      className={`uos-tip uos-icon-btn ${size === 'sm' ? 'uos-icon-btn-sm' : ''} ${active ? 'is-active' : ''} ${className}`}
      {...rest}
    >
      <Icon size={size === 'sm' ? 16 : 18} aria-hidden />
      <span className="uos-tip-text" role="presentation">{label}</span>
    </button>
  ),
);
IconButton.displayName = 'IconButton';
