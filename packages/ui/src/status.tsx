import type { RequestStatus } from '@saga/contracts';
import { cn } from './cn';

/**
 * Request status — always a mark plus a word, never bare color. The
 * streaming state breathes (a compositor-only ping), and stops breathing
 * under prefers-reduced-motion.
 */
const STATUS_META: Record<
  RequestStatus | 'in_flight',
  { label: string; dot: string; text: string; live?: boolean }
> = {
  in_flight: { label: 'streaming', dot: 'bg-info', text: 'text-info', live: true },
  ok: { label: 'ok', dot: 'bg-ok', text: 'text-ok' },
  upstream_error: { label: 'error', dot: 'bg-err', text: 'text-err' },
  client_aborted: { label: 'aborted', dot: 'bg-ink-faint', text: 'text-ink-dim' },
  capture_incomplete: { label: 'partial', dot: 'bg-warn', text: 'text-warn' },
};

export function StatusPill({
  status,
  className,
}: {
  status: RequestStatus | null;
  className?: string;
}) {
  const meta = STATUS_META[status ?? 'in_flight'];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 text-[12px] font-medium',
        meta.text,
        className,
      )}
    >
      <span className="relative inline-flex size-1.5">
        {meta.live ? (
          <span
            className={cn(
              'absolute inset-0 rounded-full',
              meta.dot,
              'animate-[saga-ping_1.4s_var(--ease-out)_infinite] motion-reduce:animate-none',
            )}
          />
        ) : null}
        <span className={cn('relative inline-flex size-1.5 rounded-full', meta.dot)} />
      </span>
      {meta.label}
    </span>
  );
}
