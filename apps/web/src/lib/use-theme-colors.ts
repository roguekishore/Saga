import { useEffect, useState } from 'react';

function cssColor(name: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || '#888888';
}

/**
 * Resolved values of --saga-* custom properties, re-read when the html class
 * flips theme. WebGL materials cannot consume CSS variables directly; this is
 * the bridge that keeps 3D surfaces token-driven.
 */
export function useThemeColors(vars: string[]): string[] {
  const key = vars.join('|');
  const [colors, setColors] = useState(() => vars.map(cssColor));
  useEffect(() => {
    const read = (): void => setColors(key.split('|').map(cssColor));
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, [key]);
  return colors;
}
