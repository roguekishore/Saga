import type { SseFrame } from '@saga/contracts';

/**
 * SSE record parser with tail buffering. Frames split across network chunks
 * are the norm, not the edge case — a naive per-chunk parse silently drops
 * events. Feed it decoded text; it returns only complete records and keeps
 * the incomplete tail for the next push. `flush()` drains whatever remains
 * at stream end.
 */
export class SseParser {
  private tail = '';

  push(chunk: string): SseFrame[] {
    this.tail += chunk;
    const frames: SseFrame[] = [];
    // A record ends at a blank line: \n\n or \r\n\r\n (mixed tolerated).
    for (;;) {
      const m = this.tail.match(/\r?\n\r?\n/);
      if (!m || m.index === undefined) break;
      const record = this.tail.slice(0, m.index);
      this.tail = this.tail.slice(m.index + m[0].length);
      const frame = parseRecord(record);
      if (frame) frames.push(frame);
    }
    return frames;
  }

  flush(): SseFrame[] {
    const rest = this.tail;
    this.tail = '';
    if (!rest.trim()) return [];
    const frame = parseRecord(rest);
    return frame ? [frame] : [];
  }

  get pendingBytes(): number {
    return this.tail.length;
  }
}

function parseRecord(record: string): SseFrame | null {
  let event: string | null = null;
  const dataLines: string[] = [];
  for (const rawLine of record.split(/\r?\n/)) {
    if (rawLine.startsWith(':')) continue; // comment / keepalive
    const colon = rawLine.indexOf(':');
    const field = colon === -1 ? rawLine : rawLine.slice(0, colon);
    let value = colon === -1 ? '' : rawLine.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') dataLines.push(value);
    // id:/retry: are irrelevant to capture
  }
  if (event === null && dataLines.length === 0) return null;
  const data = dataLines.join('\n');
  let json: unknown = null;
  if (data && data !== '[DONE]') {
    try {
      json = JSON.parse(data);
    } catch {
      json = null;
    }
  }
  return { event, data, json };
}
