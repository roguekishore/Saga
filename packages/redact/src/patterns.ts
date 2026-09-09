/**
 * Known secret shapes. Order matters: specific prefixes run before generic
 * ones so `sk-ant-…` is tagged anthropic-key, not openai-key.
 *
 * Every replacement keeps a 6-hex-char SHA-256 prefix of the original so two
 * occurrences of the same secret correlate without revealing anything.
 */
export interface SecretPattern {
  kind: string;
  re: RegExp;
  /** Which capture group holds the secret; 0 = whole match. */
  group?: number;
}

export const SECRET_PATTERNS: SecretPattern[] = [
  {
    kind: 'private-key-block',
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  { kind: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{16,}/g },
  { kind: 'openai-key', re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'github-pat', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { kind: 'github-fine-pat', re: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g },
  { kind: 'aws-access-key-id', re: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g },
  {
    kind: 'aws-secret-key',
    re: /\baws(?:.{0,24}?)(?:secret|sk)(?:.{0,12}?)['"=:\s]+['"]?([A-Za-z0-9/+=]{40})\b/gi,
    group: 1,
  },
  { kind: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { kind: 'bearer-token', re: /\b[Bb]earer\s+([A-Za-z0-9._~+/=-]{16,})/g, group: 1 },
  {
    kind: 'assigned-secret',
    re: /\b(api[-_]?key|apikey|access[-_]?token|refresh[-_]?token|client[-_]?secret|secret[-_]?key|auth[-_]?token|session[-_]?token|password|passwd)\b["']?\s*[:=]\s*["']?([^\s"'`,;&<>]{8,})/gi,
    group: 2,
  },
  {
    kind: 'cookie-header',
    re: /\b([Cc]ookie|[Ss]et-[Cc]ookie)\s*:\s*([^\r\n"]{8,})/g,
    group: 2,
  },
  /**
   * Stable device/machine fingerprints. Not a credential — it grants nothing —
   * but it identifies the machine across every request forever, so it does not
   * belong on disk or on screen.
   *
   * Claude Code ships one as `device_id` inside the JSON *string* at
   * `metadata.user_id`, which is why this matches escaped quotes (`\"key\":`)
   * as well as plain ones: by the time the text reaches here it is JSON nested
   * in JSON. The 64-hex value it carries clears every other net here — the
   * entropy backstop only flags hex at 96+ chars (verified 2026-09-04) — so
   * without this pattern it stored in the clear.
   *
   * The sibling `session_id` is deliberately left alone: the adapter has
   * already lifted it into a typed field, and it is the session boundary.
   */
  {
    kind: 'device-fingerprint',
    re: /\\?"?\b(device[-_]?id|machine[-_]?id|installation[-_]?id)\b\\?"?\s*[:=]\s*\\?"?([A-Za-z0-9_-]{16,})/gi,
    group: 2,
  },
];

/**
 * Header names whose values are redacted wholesale before anything else sees
 * them — no pattern matching, no exceptions.
 */
export const SENSITIVE_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'api-key',
  'x-goog-api-key',
  'x-auth-token',
  'cookie',
  'set-cookie',
  'x-amz-security-token',
  'x-aws-ec2-metadata-token',
]);

/**
 * JSON keys whose values are redacted wholesale during deep scrubs,
 * whatever the value looks like.
 */
export const SENSITIVE_KEYS =
  /^(authorization|api[-_]?key|apikey|x-api-key|token|access[-_]?token|refresh[-_]?token|id[-_]?token|secret|client[-_]?secret|secret[-_]?key|password|passwd|pwd|cookie|set-cookie|session[-_]?token|private[-_]?key|aws[-_]?secret[-_]?access[-_]?key|credentials?)$/i;
