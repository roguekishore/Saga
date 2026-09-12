import { describe, expect, test } from 'bun:test';
import { classifyTurn, TurnCorrelator } from '../src/turns';
import type { NormalizedRequest } from '@saga/contracts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function req(overrides: Partial<NormalizedRequest> = {}): NormalizedRequest {
  return {
    model: 'claude-opus-5',
    stream: false,
    system: [],
    messages: [],
    tools: [],
    paramsJson: '{"max_tokens":8192}',
    rawRequestJson: '{}',
    clientSessionId: null,
    ...overrides,
  };
}

const TOOL_RESULT_MSG = {
  role: 'user' as const,
  blocks: [{ type: 'tool_result' as const, toolUseId: 'tu_1', isError: false, content: [] }],
  contextSource: 'tool' as const,
  contextSourceInferred: false,
};

const TEXT_MSG = {
  role: 'user' as const,
  blocks: [{ type: 'text' as const, text: 'What is the capital of France?' }],
  contextSource: 'user' as const,
  contextSourceInferred: false,
};

const TOOL_USE_MSG = {
  role: 'assistant' as const,
  blocks: [
    {
      type: 'tool_use' as const,
      id: 'tu_1',
      name: 'bash',
      input: { command: 'ls' },
      inputJson: '{"command":"ls"}',
    },
  ],
  contextSource: 'assistant' as const,
  contextSourceInferred: false,
};

// ---------------------------------------------------------------------------
// classifyTurn — per-harness tests
// ---------------------------------------------------------------------------

describe('classifyTurn — Codex (harness-declared)', () => {
  test('declared turn_id with user_instructions injection → human_turn, harness-declared', () => {
    const result = classifyTurn({
      request: req({
        harnessIdentity: { sessionId: 'ses_abc', threadId: null, turnId: 'turn_42', parentTurnId: null },
        injections: [{ type: 'user_instructions', location: null, detail: null }],
      }),
      headers: {},
      adapterId: 'codex-responses',
      door: 'A',
    });

    expect(result.kind).toBe('human_turn');
    expect(result.source).toBe('harness-declared');
    expect(result.harnessTurnId).toBe('turn_42');
    expect(result.evidence).toContain('codex.client_metadata.turn_id');
    expect(result.evidence.some((e) => e.includes('user_instructions'))).toBe(true);
  });

  test('declared turn_id without user_instructions → tool_continuation, harness-declared', () => {
    const result = classifyTurn({
      request: req({
        harnessIdentity: { sessionId: 'ses_abc', threadId: null, turnId: 'turn_42', parentTurnId: null },
        injections: [{ type: 'environment_context', location: 'diff', detail: null }],
      }),
      headers: {},
      adapterId: 'codex-responses',
      door: 'A',
    });

    expect(result.kind).toBe('tool_continuation');
    expect(result.source).toBe('harness-declared');
    expect(result.harnessTurnId).toBe('turn_42');
  });

  test('codex adapter with no harnessIdentity → unknown, inferred', () => {
    const result = classifyTurn({
      request: req({ harnessIdentity: null }),
      headers: {},
      adapterId: 'codex-responses',
      door: 'A',
    });

    expect(result.kind).toBe('unknown');
    expect(result.source).toBe('inferred');
    expect(result.harnessTurnId).toBeNull();
  });
});

describe('classifyTurn — Claude Code (structural discriminator)', () => {
  test('final message is all tool_result blocks → tool_continuation, inferred', () => {
    const result = classifyTurn({
      request: req({ messages: [TOOL_USE_MSG, TOOL_RESULT_MSG] }),
      headers: {},
      adapterId: 'anthropic',
      door: 'A',
    });

    expect(result.kind).toBe('tool_continuation');
    expect(result.source).toBe('inferred');
    expect(result.harnessTurnId).toBeNull();
    expect(result.evidence).toContain('final-message-tool-only');
  });

  test('final message has non-tool content → human_turn, inferred', () => {
    const result = classifyTurn({
      request: req({ messages: [TEXT_MSG] }),
      headers: {},
      adapterId: 'anthropic',
      door: 'A',
    });

    expect(result.kind).toBe('human_turn');
    expect(result.source).toBe('inferred');
    expect(result.harnessTurnId).toBeNull();
    expect(result.evidence).toContain('final-message-has-non-tool-content');
  });

  test('compaction injection → tool_continuation, not a new turn', () => {
    const result = classifyTurn({
      request: req({
        messages: [TEXT_MSG],
        injections: [{ type: 'compaction', location: null, detail: null }],
      }),
      headers: {},
      adapterId: 'anthropic',
      door: 'A',
    });

    expect(result.kind).toBe('tool_continuation');
    expect(result.source).toBe('inferred');
    expect(result.evidence).toContain('compaction-detected');
  });

  test('role:user trap — pushed context (tool_result) is NOT a human turn', () => {
    // Even though the last message has role:user, if all blocks are tool_result
    // it must be classified as tool_continuation, not human_turn.
    expect(TOOL_RESULT_MSG.role).toBe('user');
    const result = classifyTurn({
      request: req({ messages: [TOOL_RESULT_MSG] }),
      headers: {},
      adapterId: 'anthropic',
      door: 'A',
    });
    expect(result.kind).toBe('tool_continuation');
  });
});

describe('classifyTurn — Gemini (position-based)', () => {
  test('session_context at injection position 0 → tool_continuation', () => {
    const result = classifyTurn({
      request: req({
        messages: [TEXT_MSG],
        injections: [{ type: 'session_context', location: 'history[0]', detail: null }],
      }),
      headers: {},
      adapterId: 'gemini',
      door: 'B',
    });

    expect(result.kind).toBe('tool_continuation');
    expect(result.source).toBe('inferred');
    expect(result.evidence).toContain('gemini-session-context-position-0');
  });

  test('no session_context, final message is user non-tool → human_turn', () => {
    const result = classifyTurn({
      request: req({ messages: [TEXT_MSG] }),
      headers: {},
      adapterId: 'gemini',
      door: 'B',
    });

    expect(result.kind).toBe('human_turn');
    expect(result.source).toBe('inferred');
  });

  test('no session_context, final message is function response (tool_result) → tool_continuation', () => {
    const result = classifyTurn({
      request: req({ messages: [TOOL_RESULT_MSG] }),
      headers: {},
      adapterId: 'gemini',
      door: 'B',
    });

    expect(result.kind).toBe('tool_continuation');
    expect(result.source).toBe('inferred');
  });
});

describe('classifyTurn — fallback', () => {
  test('unknown adapterId → unknown, inferred', () => {
    const result = classifyTurn({
      request: req({ messages: [TEXT_MSG] }),
      headers: {},
      adapterId: 'some-future-adapter',
      door: 'A',
    });

    expect(result.kind).toBe('unknown');
    expect(result.source).toBe('inferred');
    expect(result.harnessTurnId).toBeNull();
    expect(result.evidence.some((e) => e.includes('some-future-adapter'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TurnCorrelator — stateful assignment
// ---------------------------------------------------------------------------

describe('TurnCorrelator', () => {
  function makeCorrelator() {
    let n = 0;
    return new TurnCorrelator(() => `id${n++}`);
  }

  test('human_turn opens a new turn; tool_continuations fold under it', () => {
    const c = makeCorrelator();
    const base = { sessionId: 'ses_1', ts: 0 };

    const open = c.assign({
      ...base,
      classification: { kind: 'human_turn', source: 'inferred', harnessTurnId: null, evidence: [] },
    });
    expect(open.opened).toBe(true);
    expect(open.seq).toBe(0);
    expect(open.partial).toBe(false);

    const cont1 = c.assign({
      ...base,
      ts: 100,
      classification: { kind: 'tool_continuation', source: 'inferred', harnessTurnId: null, evidence: [] },
    });
    const cont2 = c.assign({
      ...base,
      ts: 200,
      classification: { kind: 'tool_continuation', source: 'inferred', harnessTurnId: null, evidence: [] },
    });

    expect(cont1.turnId).toBe(open.turnId);
    expect(cont2.turnId).toBe(open.turnId);
    expect(cont1.opened).toBe(false);
    expect(cont2.opened).toBe(false);
  });

  test('second human_turn opens a new turn with seq+1', () => {
    const c = makeCorrelator();
    const s = 'ses_1';

    const t1 = c.assign({
      sessionId: s,
      ts: 0,
      classification: { kind: 'human_turn', source: 'inferred', harnessTurnId: null, evidence: [] },
    });
    const t2 = c.assign({
      sessionId: s,
      ts: 100,
      classification: { kind: 'human_turn', source: 'inferred', harnessTurnId: null, evidence: [] },
    });

    expect(t2.turnId).not.toBe(t1.turnId);
    expect(t2.seq).toBe(1);
    expect(t2.opened).toBe(true);
  });

  test('harness-declared turn id keys the turn directly', () => {
    const c = makeCorrelator();
    const s = 'ses_codex';
    const cls = (tid: string) => ({
      kind: 'tool_continuation' as const,
      source: 'harness-declared' as const,
      harnessTurnId: tid,
      evidence: [],
    });

    const a = c.assign({ sessionId: s, ts: 0, classification: cls('turn_42') });
    const b = c.assign({ sessionId: s, ts: 100, classification: cls('turn_42') });
    const c2 = c.assign({ sessionId: s, ts: 200, classification: cls('turn_43') });

    expect(b.turnId).toBe(a.turnId);
    expect(b.opened).toBe(false);
    expect(c2.turnId).not.toBe(a.turnId);
    expect(c2.opened).toBe(true);
  });

  test('continuation with no open turn → partial=true, no throw', () => {
    const c = makeCorrelator();
    const result = c.assign({
      sessionId: 'ses_mid',
      ts: 0,
      classification: { kind: 'tool_continuation', source: 'inferred', harnessTurnId: null, evidence: [] },
    });

    expect(result.partial).toBe(true);
    expect(result.opened).toBe(true);
    expect(result.turnId).toBeTruthy();
  });
});
