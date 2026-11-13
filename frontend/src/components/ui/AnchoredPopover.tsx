import React, { useLayoutEffect, useRef, useState, useEffect } from 'react';
import { createPortal } from 'react-dom';

/**
 * A popover rendered into document.body at a fixed position next to its anchor and clamped
 * to the viewport, so it is never clipped by a scrolling column and never drawn over the
 * group it belongs to (fixes the CODE_UI_AUDIT §3 tool pop-over overlap / clipping).
 *
 * placement 'right' puts it beside the anchor (palette in a side column); 'below' under it.
 * Its height is capped to the viewport and its body scrolls.
 */
export const AnchoredPopover: React.FC<{
  anchor: HTMLElement | null;
  /** Optional element whose top the popover aligns to (e.g. the active tool), while 'anchor' sets the side. */
  alignTop?: HTMLElement | null;
  open: boolean;
  onClose?: () => void;
  placement?: 'right' | 'below';
  width?: number;
  label: string;
  testId?: string;
  children: React.ReactNode;
}> = ({ anchor, alignTop, open, onClose, placement = 'right', width = 280, label, testId, children }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight: number } | null>(null);

  useLayoutEffect(() => {
    if (!open || !anchor) { setPos(null); return; }
    const place = () => {
      const r = anchor.getBoundingClientRect();
      const vw = window.innerWidth, vh = window.innerHeight, m = 8;
      const h = ref.current?.offsetHeight ?? 0;
      let left: number, top: number;
      if (placement === 'right') {
        left = r.right + m;
        if (left + width > vw - m) left = Math.max(m, r.left - width - m); // flip to the left side
        top = alignTop ? alignTop.getBoundingClientRect().top : r.top;
      } else {
        left = Math.min(Math.max(m, r.left), vw - width - m);
        top = r.bottom + m;
      }
      const maxHeight = Math.max(160, vh - 2 * m);
      const eh = Math.min(h, maxHeight);
      // 'below' flips above the anchor when it does not fit underneath, so it never covers its own anchor if avoidable
      if (h && placement === 'below' && top + eh > vh - m && r.top - m - eh >= m) top = r.top - m - eh;
      if (h && top + eh > vh - m) top = Math.max(m, vh - m - eh);
      setPos({ left, top, maxHeight });
    };
    place();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(place) : null;
    if (ro && ref.current) ro.observe(ref.current);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { ro?.disconnect(); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open, anchor, alignTop, placement, width]);

  useEffect(() => {
    if (!open || !onClose) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open || typeof document === 'undefined') return null;
  return createPortal(
    <div ref={ref} role="dialog" aria-label={label} data-testid={testId}
      className="fixed z-[60] overflow-y-auto rounded-lg border p-3 text-xs pointer-events-auto"
      style={{
        left: pos?.left ?? -9999, top: pos?.top ?? -9999, width, maxHeight: pos?.maxHeight,
        background: 'var(--surface-1, #161B22)', borderColor: 'var(--border-strong, #4A5563)',
        color: 'var(--text-1, #E6EAF0)', boxShadow: '0 4px 16px rgba(0,0,0,.35)',
      }}>
      {children}
    </div>,
    document.body,
  );
};
