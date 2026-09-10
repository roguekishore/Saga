/** Formatting helpers shared by every page. Data-dense, unambiguous. */

export function fmtInt(n: number): string {
  return new Intl.NumberFormat('en-US').format(Math.round(n));
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 10_000) return `${(n / 1000).toFixed(0)}k`;
  if (n >= 1_000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

export function fmtMs(ms: number | null | undefined): string {
  if (ms == null) return '–';
  if (ms < 1) return '<1ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export function fmtBytes(b: number | null | undefined): string {
  if (b == null) return '–';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function fmtTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

export function fmtDateTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')} ${fmtTime(ts)}`;
}

/** HH:MM:SS.mmm — for spans whose interesting differences are milliseconds. */
export function fmtClockMs(ts: number): string {
  return `${fmtTime(ts)}.${String(new Date(ts).getMilliseconds()).padStart(3, '0')}`;
}

/**
 * Clock time when `ts` shares a calendar day with `ref`, else the full
 * date-time. A bare HH:MM:SS on a message carried over from last week reads as
 * "just sent"; the date is what stops that misreading.
 */
export function fmtTimeOrDate(ts: number, ref: number = Date.now()): string {
  const a = new Date(ts);
  const b = new Date(ref);
  const sameDay =
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  return sameDay ? fmtTime(ts) : fmtDateTime(ts);
}

export function timeAgo(ts: number, now: number = Date.now()): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function shortId(id: string, keep = 8): string {
  if (id.length <= keep + 6) return id;
  const [prefix, rest] = id.includes('_') ? id.split(/_(.*)/s) : ['', id];
  const tailPart = (rest ?? id).slice(-keep);
  return prefix ? `${prefix}_…${tailPart}` : `…${tailPart}`;
}

export function pct(x: number | null | undefined, digits = 1): string {
  if (x == null) return 'n/a';
  return `${(x * 100).toFixed(digits)}%`;
}
