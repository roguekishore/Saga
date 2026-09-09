import type { ContentBlock, NormalizedMessage, NormalizedRequest } from '@saga/contracts';
import { findEntropySuspects } from './entropy';
import { SECRET_PATTERNS, SENSITIVE_HEADERS, SENSITIVE_KEYS } from './patterns';

export interface RedactionHit {
  kind: string;
  count: number;
}

export interface ScrubResult<T> {
  value: T;
  hits: RedactionHit[];
  /** True when the fail-closed entropy backstop fired. */
  flagged: boolean;
}

function fingerprint(secret: string): string {
  const h = new Bun.CryptoHasher('sha256');
  h.update(secret);
  return h.digest('hex').slice(0, 6);
}

function placeholder(kind: string, secret: string): string {
  return `[REDACTED:${kind}:${fingerprint(secret)}]`;
}

class HitCollector {
  private readonly map = new Map<string, number>();
  flagged = false;
  add(kind: string, n = 1): void {
    this.map.set(kind, (this.map.get(kind) ?? 0) + n);
  }
  toHits(): RedactionHit[] {
    return [...this.map.entries()]
      .map(([kind, count]) => ({ kind, count }))
      .sort((a, b) => a.kind.localeCompare(b.kind));
  }
}

function scrubTextInto(text: string, hits: HitCollector): string {
  let out = text;
  for (const p of SECRET_PATTERNS) {
    out = out.replace(p.re, (whole, ...rest) => {
      const groups = rest.slice(0, -2) as string[]; // trailing (offset, string)
      hits.add(p.kind);
      if (p.group && p.group > 0) {
        const secret = groups[p.group - 1] ?? whole;
        return whole.replace(secret, placeholder(p.kind, secret));
      }
      return placeholder(p.kind, whole);
    });
  }
  // Fail-closed backstop, after all known shapes are gone.
  for (const suspect of findEntropySuspects(out)) {
    hits.add('entropy-suspect');
    hits.flagged = true;
    out = out.split(suspect).join(placeholder('entropy-suspect', suspect));
  }
  return out;
}

export function scrubText(text: string): ScrubResult<string> {
  const hits = new HitCollector();
  const value = scrubTextInto(text, hits);
  return { value, hits: hits.toHits(), flagged: hits.flagged };
}

function scrubUnknownInto(v: unknown, hits: HitCollector): unknown {
  if (typeof v === 'string') return scrubTextInto(v, hits);
  if (Array.isArray(v)) return v.map((x) => scrubUnknownInto(x, hits));
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (SENSITIVE_KEYS.test(k) && val != null && val !== '') {
        hits.add('sensitive-key');
        out[k] = placeholder('sensitive-key', typeof val === 'string' ? val : JSON.stringify(val));
      } else {
        out[k] = scrubUnknownInto(val, hits);
      }
    }
    return out;
  }
  return v;
}

/** Deep-scrub any JSON-shaped value (sensitive keys wholesale, strings by pattern). */
export function scrubValue(v: unknown): ScrubResult<unknown> {
  const hits = new HitCollector();
  const value = scrubUnknownInto(v, hits);
  return { value, hits: hits.toHits(), flagged: hits.flagged };
}

/** Headers: sensitive names are redacted wholesale; the rest get a text scrub. */
export function scrubHeaders(headers: Record<string, string>): ScrubResult<Record<string, string>> {
  const hits = new HitCollector();
  const out: Record<string, string> = {};
  for (const [name, val] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (SENSITIVE_HEADERS.has(lower)) {
      hits.add('sensitive-header');
      out[lower] = `[REDACTED:header:${fingerprint(val)}]`;
    } else {
      out[lower] = scrubTextInto(val, hits);
    }
  }
  return { value: out, hits: hits.toHits(), flagged: hits.flagged };
}

function scrubBlockInto(b: ContentBlock, hits: HitCollector): ContentBlock {
  switch (b.type) {
    case 'text':
      return { ...b, text: scrubTextInto(b.text, hits) };
    case 'thinking':
      return { ...b, thinking: scrubTextInto(b.thinking, hits) };
    case 'tool_use':
      return {
        ...b,
        input: b.input == null ? b.input : scrubUnknownInto(b.input, hits),
        inputJson: b.inputJson == null ? b.inputJson : scrubTextInto(b.inputJson, hits),
      };
    case 'tool_result':
      return {
        ...b,
        content: b.content.map((c) =>
          c.type === 'text' ? { ...c, text: scrubTextInto(c.text, hits) } : c,
        ),
      };
    case 'unknown':
      return { ...b, json: scrubTextInto(b.json, hits) };
    case 'redacted_thinking':
    case 'image':
      return b;
  }
}

export function redactMessage(msg: NormalizedMessage): ScrubResult<NormalizedMessage> {
  const hits = new HitCollector();
  const value: NormalizedMessage = {
    ...msg,
    blocks: msg.blocks.map((b) => scrubBlockInto(b, hits)),
  };
  return { value, hits: hits.toHits(), flagged: hits.flagged };
}

/**
 * Scrub an entire normalized request before it reaches the queue — the write
 * path's front door. Everything downstream (store, WebSocket, UI) only ever
 * sees the output of this function.
 */
export function redactNormalizedRequest(req: NormalizedRequest): ScrubResult<NormalizedRequest> {
  const hits = new HitCollector();
  const scrubMsg = (m: NormalizedMessage): NormalizedMessage => ({
    ...m,
    blocks: m.blocks.map((b) => scrubBlockInto(b, hits)),
  });
  const value: NormalizedRequest = {
    ...req,
    system: req.system.map(scrubMsg),
    messages: req.messages.map(scrubMsg),
    paramsJson: scrubTextInto(req.paramsJson, hits),
    rawRequestJson: scrubTextInto(req.rawRequestJson, hits),
  };
  return { value, hits: hits.toHits(), flagged: hits.flagged };
}
