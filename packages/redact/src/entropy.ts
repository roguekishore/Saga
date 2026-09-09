/**
 * Fail-closed backstop: an unrecognized high-entropy blob is scrubbed AND
 * flagged rather than silently stored. Tuned to catch credential-shaped
 * strings while leaving code identifiers, UUIDs, git SHAs, and prose alone —
 * but when in doubt, it redacts. A false positive costs a token of debug
 * info; a false negative puts a secret on disk.
 */

const CANDIDATE_RE = /[A-Za-z0-9_+=-]{24,}/g;
const UUID_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
const HEX_RE = /^[0-9a-fA-F]+$/;

export function shannonEntropy(s: string): number {
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

export function looksLikeSecret(token: string): boolean {
  if (token.includes('REDACTED')) return false;
  if (UUID_RE.test(token)) return false;

  // Pure hex: git SHAs (40) and sha256 (64) live in prompts constantly.
  // Only very long, high-entropy hex (raw key material) is suspicious.
  if (HEX_RE.test(token)) {
    return token.length >= 96 && shannonEntropy(token) >= 3.5;
  }

  const digits = (token.match(/[0-9]/g) ?? []).length;
  const lower = (token.match(/[a-z]/g) ?? []).length;
  const upper = (token.match(/[A-Z]/g) ?? []).length;

  // Credential alphabets mix cases and digits; identifiers rarely mix all
  // three densely at this length.
  if (digits < 2 || lower === 0 || upper === 0) return false;

  // snake/camel identifiers have long single-case runs; base64 does not.
  const longRun = /[a-z]{12,}|[A-Z]{12,}/.test(token);
  if (longRun) return false;

  return shannonEntropy(token) >= 4.0;
}

export function findEntropySuspects(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(CANDIDATE_RE)) {
    if (looksLikeSecret(m[0])) out.push(m[0]);
  }
  return out;
}
