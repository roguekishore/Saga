import { describe, expect, test } from 'bun:test';
import { extractWorkspace, SessionCorrelator } from '../src/session';
import { ulid } from '../src/ulid';

describe('ulid', () => {
  test('monotonic within one ms, sortable across time', () => {
    const a = ulid(1000);
    const b = ulid(1000);
    const c = ulid(2000);
    expect(b > a).toBe(true);
    expect(c > b).toBe(true);
    expect(a.length).toBe(26);
  });
});

describe('SessionCorrelator — client-declared (wire evidence)', () => {
  const CC = '595d6fa3-cc08-4e0f-abad-cacf6f8995f3';

  test('a stated session id is the session: model switches do not split it', () => {
    let n = 0;
    const c = new SessionCorrelator(() => `id${n++}`, 1000);
    const base = { clientName: 'cli', workspace: null, clientSessionId: CC };
    // The regression this fixes: Claude Code interleaving a sonnet call inside
    // an opus conversation used to shatter one conversation into a session per
    // system prompt. Same stated id → one session, whatever the prompt.
    const opus = c.assign({ ...base, systemFingerprint: 'fp-opus', ts: 0 });
    const sonnet = c.assign({ ...base, systemFingerprint: 'fp-sonnet', ts: 100 });
    const haiku = c.assign({ ...base, systemFingerprint: 'fp-haiku', ts: 200 });
    expect(sonnet.sessionId).toBe(opus.sessionId);
    expect(haiku.sessionId).toBe(opus.sessionId);
    expect(opus.source).toBe('client-declared');
    expect(opus.clientSessionId).toBe(CC);
  });

  test('idle time never splits a stated session, and the id is derived not minted', () => {
    const c = new SessionCorrelator(() => 'must-not-be-used', 1000);
    const base = { clientName: 'cli', workspace: null, systemFingerprint: 'fp' };
    const a = c.assign({ ...base, clientSessionId: CC, ts: 0 });
    const b = c.assign({ ...base, clientSessionId: CC, ts: 9_999_999 });
    expect(b.sessionId).toBe(a.sessionId);
    expect(a.sessionId).toBe(`ses_${CC}`);
    expect(a.sessionId).not.toContain('must-not-be-used');
  });

  test('derivation is restart-safe: a fresh correlator lands on the same id', () => {
    const c1 = new SessionCorrelator(() => 'a');
    const c2 = new SessionCorrelator(() => 'b');
    const input = { clientName: 'cli', workspace: null, systemFingerprint: 'fp', ts: 0 };
    expect(c2.assign({ ...input, clientSessionId: CC }).sessionId).toBe(
      c1.assign({ ...input, clientSessionId: CC }).sessionId,
    );
  });

  test('two concurrent conversations stay apart even with identical prompts', () => {
    const c = new SessionCorrelator(() => 'x');
    const other = '9a07445e-e9ca-4926-b55b-465d2a8fc983';
    const base = { clientName: 'cli', workspace: null, systemFingerprint: 'same-fp' };
    // Both projects run `cli` with a null workspace; only the stated id differs.
    const a = c.assign({ ...base, clientSessionId: CC, ts: 0 });
    const b = c.assign({ ...base, clientSessionId: other, ts: 1 });
    expect(b.sessionId).not.toBe(a.sessionId);
  });
});

describe('SessionCorrelator — inferred fallback (heuristic)', () => {
  test('workspace anchors the session; different system prompts stay together', () => {
    let n = 0;
    const c = new SessionCorrelator(() => `id${n++}`, 1000);
    const base = { clientName: 'cc', workspace: '/w', systemFingerprint: 'abc' };
    const s1 = c.assign({ ...base, ts: 0 });
    const s2 = c.assign({ ...base, ts: 500 });
    // multi-agent: same workspace, DIFFERENT prompt → same session
    const sub = c.assign({ ...base, systemFingerprint: 'zzz', ts: 600 });
    const s3 = c.assign({ ...base, ts: 5000 }); // idle exceeded → new session
    const other = c.assign({ ...base, workspace: '/elsewhere', ts: 5100 });
    expect(s2.sessionId).toBe(s1.sessionId);
    expect(sub.sessionId).toBe(s1.sessionId);
    expect(s3.sessionId).not.toBe(s1.sessionId);
    expect(other.sessionId).not.toBe(s3.sessionId);
    expect(s1.source).toBe('inferred');
    expect(s1.clientSessionId).toBeNull();
  });

  test('without a workspace, the prompt fingerprint is the only signal', () => {
    let n = 0;
    const c = new SessionCorrelator(() => `id${n++}`, 1000);
    const base = { clientName: 'curl', workspace: null, systemFingerprint: 'abc' };
    const s1 = c.assign({ ...base, ts: 0 });
    const s2 = c.assign({ ...base, systemFingerprint: 'zzz', ts: 100 });
    expect(s2.sessionId).not.toBe(s1.sessionId);
    expect(s2.source).toBe('inferred');
  });

  test('an empty stated id falls through to the heuristic rather than keying on it', () => {
    const c = new SessionCorrelator(() => 'id0');
    const got = c.assign({
      clientName: 'cli',
      workspace: null,
      systemFingerprint: 'fp',
      ts: 0,
      clientSessionId: null,
    });
    expect(got.source).toBe('inferred');
    expect(got.sessionId).toBe('ses_id0');
  });
});

describe('workspace extraction (heuristic, labeled inferred)', () => {
  test('finds Claude Code style working directory', () => {
    const ws = extractWorkspace({
      model: null,
      stream: false,
      system: [
        {
          role: 'system',
          blocks: [
            { type: 'text', text: 'You are a CLI.\nPrimary working directory: /home/dev/proj\n' },
          ],
          contextSource: 'system',
          contextSourceInferred: false,
        },
      ],
      messages: [],
      tools: [],
      paramsJson: '{}',
      rawRequestJson: '{}',
    });
    expect(ws).toBe('/home/dev/proj');
  });
});
