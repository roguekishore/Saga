let cached: boolean | null = null;

/**
 * One-time WebGL capability probe. 3D surfaces are progressive enhancement:
 * callers must render their 2D equivalent when this returns false.
 */
export function webglAvailable(): boolean {
  if (cached !== null) return cached;
  try {
    const canvas = document.createElement('canvas');
    cached = Boolean(canvas.getContext('webgl2') ?? canvas.getContext('webgl'));
  } catch {
    cached = false;
  }
  return cached;
}
