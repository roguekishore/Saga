import { cn, dur, ease } from '@saga/ui';
import { motion } from 'motion/react';
import type { ReactNode } from 'react';

/**
 * Standard page chrome: one quiet entrance for every route so navigation has
 * continuity without theater. `flush` is for full-height working surfaces
 * (live feed, logs, sql) that own their scroll and padding.
 */
export function Page({
  children,
  className,
  flush = false,
}: {
  children: ReactNode;
  className?: string;
  flush?: boolean;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: dur.base, ease: ease.out }}
      className={cn(flush ? 'h-full' : 'space-y-3 p-4', className)}
    >
      {children}
    </motion.div>
  );
}
