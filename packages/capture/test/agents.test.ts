import { describe, expect, test } from 'bun:test';
import { AgentCorrelator, labelFromSystem } from '../src/agents';

describe('AgentCorrelator (heuristic, labeled inferred)', () => {
  function make() {
    let n = 0;
    return new AgentCorrelator(() => `id${n++}`);
  }

  test('same fingerprint stays one agent; first agent is the root', () => {
    const c = make();
    const a1 = c.assign({
      sessionId: 's',
      requestId: 'r1',
      systemFingerprint: 'fpA',
      systemHead: '',
      ts: 0,
    });
    c.finish('s', 'r1');
    const a2 = c.assign({
      sessionId: 's',
      requestId: 'r2',
      systemFingerprint: 'fpA',
      systemHead: '',
      ts: 10,
    });
    expect(a2.agentId).toBe(a1.agentId);
    expect(a1.parentAgentId).toBeNull();
    expect(a1.label).toBe('main');
  });

  test('new fingerprint while parent in flight → child of the in-flight agent', () => {
    const c = make();
    const main = c.assign({
      sessionId: 's',
      requestId: 'r1',
      systemFingerprint: 'fpA',
      systemHead: '',
      ts: 0,
    });
    // r1 still in flight (Task tool blocks the parent) when the subagent fires
    const sub = c.assign({
      sessionId: 's',
      requestId: 'r2',
      systemFingerprint: 'fpB',
      systemHead: 'You are a code reviewer for this repository.',
      ts: 5,
    });
    expect(sub.parentAgentId).toBe(main.agentId);
    expect(sub.label).toBe('code reviewer');
    c.finish('s', 'r1');
    c.finish('s', 'r2');
  });

  test('no in-flight overlap → sibling root, not child', () => {
    const c = make();
    const main = c.assign({
      sessionId: 's',
      requestId: 'r1',
      systemFingerprint: 'fpA',
      systemHead: '',
      ts: 0,
    });
    c.finish('s', 'r1'); // parent finished BEFORE the new prompt appears
    const other = c.assign({
      sessionId: 's',
      requestId: 'r2',
      systemFingerprint: 'fpB',
      systemHead: '',
      ts: 10,
    });
    expect(other.parentAgentId).toBeNull();
    expect(main.agentId).not.toBe(other.agentId);
  });

  test('sessions are isolated from each other', () => {
    const c = make();
    c.assign({ sessionId: 's1', requestId: 'r1', systemFingerprint: 'fpA', systemHead: '', ts: 0 });
    const inS2 = c.assign({
      sessionId: 's2',
      requestId: 'r2',
      systemFingerprint: 'fpB',
      systemHead: '',
      ts: 1,
    });
    // s1's in-flight request must not become s2's parent
    expect(inS2.parentAgentId).toBeNull();
  });
});

/**
 * Regression cover for the bug that made agent correlation inert.
 *
 * Session identity used to be keyed on the system-prompt fingerprint, so the
 * fingerprint was spent before AgentCorrelator ever ran: every session held
 * exactly one agent and no parent edge could exist. Replaying the real corpus
 * confirmed it (2026-09-04) — 24 sessions, 24 agents, 0 parent edges before;
 * 11 sessions, 21 agents, 6 with an inferred parent after.
 *
 * These tests assert the shape that replay found, using the session id as the
 * boundary the way the fixed proxy does.
 */
describe('agents inside a client-declared session', () => {
  const SESSION = 'ses_595d6fa3-cc08-4e0f-abad-cacf6f8995f3';

  test('a side-model call mid-conversation is an agent, not a new session', () => {
    let n = 0;
    const c = new AgentCorrelator(() => `id${n++}`);
    // Claude Code interleaving sonnet inside an opus conversation: one session,
    // two system prompts. This used to produce two SESSIONS of one agent each.
    const opus = c.assign({
      sessionId: SESSION,
      requestId: 'r1',
      systemFingerprint: 'fp-opus',
      systemHead: '',
      ts: 0,
    });
    c.finish(SESSION, 'r1');
    const sonnet = c.assign({
      sessionId: SESSION,
      requestId: 'r2',
      systemFingerprint: 'fp-sonnet',
      systemHead: '',
      ts: 10,
    });
    expect(sonnet.agentId).not.toBe(opus.agentId);
    // Sequential, not nested: no request was in flight when it started.
    expect(sonnet.parentAgentId).toBeNull();
  });

  test('subagents spawned while the main loop blocks become its children', () => {
    let n = 0;
    const c = new AgentCorrelator(() => `id${n++}`);
    const main = c.assign({
      sessionId: SESSION,
      requestId: 'r1',
      systemFingerprint: 'fp-main',
      systemHead: '',
      ts: 0,
    });
    // Main is blocked on the Task tool; three subagents run under it. All of
    // this is one conversation, so all of it shares the session id.
    const kids = ['fp-explore', 'fp-plan', 'fp-review'].map((fp, i) =>
      c.assign({
        sessionId: SESSION,
        requestId: `sub${i}`,
        systemFingerprint: fp,
        systemHead: '',
        ts: 5 + i,
      }),
    );
    expect(new Set(kids.map((k) => k.agentId)).size).toBe(3);
    expect(kids.every((k) => k.parentAgentId !== null)).toBe(true);
    expect(kids[0]?.parentAgentId).toBe(main.agentId);
    // The whole point: edges exist at all.
    expect(kids.filter((k) => k.parentAgentId).length).toBeGreaterThan(0);
  });

  test('one agent per fingerprint, however many requests it makes', () => {
    let n = 0;
    const c = new AgentCorrelator(() => `id${n++}`);
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const a = c.assign({
        sessionId: SESSION,
        requestId: `r${i}`,
        systemFingerprint: i % 2 === 0 ? 'fp-main' : 'fp-sub',
        systemHead: '',
        ts: i,
      });
      c.finish(SESSION, `r${i}`);
      ids.add(a.agentId);
    }
    expect(ids.size).toBe(2);
  });
});

describe('labelFromSystem', () => {
  test('extracts a short role phrase or falls back', () => {
    expect(labelFromSystem('You are a precise coding assistant. Work hard.', 1)).toBe(
      'precise coding assistant',
    );
    expect(labelFromSystem('You are the Explore agent', 2)).toBe('Explore agent');
    expect(labelFromSystem('# random preamble with no role', 0)).toBe('main');
    expect(labelFromSystem('# random preamble with no role', 3)).toBe('agent-3');
  });
});
