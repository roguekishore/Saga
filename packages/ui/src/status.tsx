import type { RequestStatus } from '@saga/contracts';
import { cn } from './cn';

const STATUS_META: Record<
  RequestStatus | 'in_flight',
  { label: string; dot: string; text: string }
> = {
  in_flight: { label: 'streaming', dot: 'bg-info animate-pulse', text: 'text-info' },
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
      <span className={cn('size-1.5 rounded-full', meta.dot)} />
      {meta.label}
    </span>
  );
}
