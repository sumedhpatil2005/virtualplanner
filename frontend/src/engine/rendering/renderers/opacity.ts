import { Color } from 'cesium';

/** Parses a CSS colour and scales its alpha by a layer opacity (0-1). */
export function withOpacity(css: string, opacity: number): Color {
  const color = Color.fromCssColorString(css);
  return color.withAlpha(color.alpha * Math.max(0, Math.min(1, opacity)));
}
