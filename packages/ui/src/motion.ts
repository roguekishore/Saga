/**
 * The SAGA motion system: one named vocabulary instead of per-component
 * guesses. These are plain data — consumers feed them to motion/react, which
 * this package deliberately does not depend on. Rules (see DESIGN.md):
 * transform/opacity only, springs for anything interactive, and reduced
 * motion handled globally (MotionConfig + the collapsed --dur-* scale).
 */

/** Seconds, matching the CSS --dur-* scale. */
export const dur = {
  fast: 0.1,
  base: 0.18,
  slow: 0.28,
  page: 0.48,
} as const;

export const ease = {
  out: [0.22, 1, 0.36, 1],
  inOut: [0.65, 0, 0.35, 1],
} as const;

/** Selection, hover lifts, small layout shifts. */
export const springSnap = { type: 'spring', stiffness: 560, damping: 42, mass: 0.9 } as const;
/** Shared-element drill-downs and larger layout moves. */
export const springSettle = { type: 'spring', stiffness: 300, damping: 34, mass: 1 } as const;
/** Overlay entrances (palette, dialogs). */
export const springPop = { type: 'spring', stiffness: 640, damping: 34, mass: 0.7 } as const;

/** Standard page/section entrance. */
export const fadeRise = {
  initial: { opacity: 0, y: 6 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -4 },
} as const;

export const fadeIn = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
} as const;

/** Stagger container for lists; pair children with `listItem`. */
export const listContainer = {
  animate: { transition: { staggerChildren: 0.018 } },
} as const;

export const listItem = {
  initial: { opacity: 0, y: 5 },
  animate: { opacity: 1, y: 0, transition: { duration: dur.base, ease: ease.out } },
} as const;

/**
 * Rows beyond this index mount without individual entrances — staggering a
 * 500-row virtualized list is noise, not continuity.
 */
export const STAGGER_CAP = 13;
