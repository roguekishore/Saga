import { describe, expect, test } from 'bun:test';
import type { NormalizedRequest } from '@saga/contracts';
import { classifyCallRole } from '../src/call-role';

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

const TEXT_MSG = {
  role: 'user' as const,
  blocks: [{ type: 'text' as const, text: 'hello' }],
  contextSource: 'user' as const,
  contextSourceInferred: false,
};

const TOOL_DEF = { name: 'bash', descriptionBytes: 20, inputSchemaBytes: 50 };

// ---------------------------------------------------------------------------
// classifyCallRole — Codex (harness-declared)
// ---------------------------------------------------------------------------

describe('classifyCallRole — Codex (harness-declared)', () => {
  const codex = 'codex-responses';

  test('x-openai-subagent absent → main, harness-declared', () => {
    const result = classifyCallRole({
      request: req(),
      headers: {},
      adapterId: codex,
      door: 'A',
      sessionModels: [],
    });

    expect(result.role).toBe('main');
    expect(result.source).toBe('harness-declared');
    expect(result.evidence).toContain('x-openai-subagent:absent');
  });

  test('x-openai-subagent: compact → utility, harness-declared', () => {
    const result = classifyCallRole({
      request: req(),
      headers: { 'x-openai-subagent': 'compact' },
      adapterId: codex,
      door: 'A',
      sessionModels: [],
    });

    expect(result.role).toBe('utility');
    expect(result.source).toBe('harness-declared');
    expect(result.evidence).toContain('x-openai-subagent:compact');
  });

  test('x-openai-subagent: memory_consolidation → utility, harness-declared', () => {
    const result = classifyCallRole({
      request: req(),
      headers: { 'x-openai-subagent': 'memory_consolidation' },
      adapterId: codex,
      door: 'A',
      sessionModels: [],
    });

    expect(result.role).toBe('utility');
    expect(result.source).toBe('harness-declared');
    expect(result.evidence).toContain('x-openai-subagent:memory_consolidation');
  });

  test('x-openai-subagent: review → subagent, harness-declared', () => {
    const result = classifyCallRole({
      request: req(),
      headers: { 'x-openai-subagent': 'review' },
      adapterId: codex,
      door: 'A',
      sessionModels: [],
    });

    expect(result.role).toBe('subagent');
    expect(result.source).toBe('harness-declared');
    expect(result.evidence).toContain('x-openai-subagent:review');
  });
});

// ---------------------------------------------------------------------------
// classifyCallRole — Claude Code (fingerprint-based)
// ---------------------------------------------------------------------------

describe('classifyCallRole — Claude Code utility fingerprint (CV-corrected)', () => {
  const anthropic = 'anthropic';

  test('tools=[] AND max_tokens=16 AND messages=2 → utility, inferred', () => {
    const result = classifyCallRole({
      request: req({
        tools: [],
        messages: [TEXT_MSG, TEXT_MSG],
        paramsJson: '{"max_tokens":16}',
      }),
      headers: {},
      adapterId: anthropic,
      door: 'A',
      sessionModels: [],
    });

    expect(result.role).toBe('utility');
    expect(result.source).toBe('inferred');
    expect(result.evidence).toContain('no-tools');
    expect(result.evidence.some((e) => e.startsWith('max_tokens<='))).toBe(true);
  });

  test('tools=[] AND max_tokens=64 AND messages=3 → utility (boundary)', () => {
    const result = classifyCallRole({
      request: req({
        tools: [],
        messages: [TEXT_MSG, TEXT_MSG, TEXT_MSG],
        paramsJson: '{"max_tokens":64}',
      }),
      headers: {},
      adapterId: anthropic,
      door: 'A',
      sessionModels: [],
    });

    expect(result.role).toBe('utility');
    expect(result.source).toBe('inferred');
  });

  test('tools=[] AND max_tokens=65 → NOT utility (just over budget)', () => {
    const result = classifyCallRole({
      request: req({
        tools: [],
        messages: [TEXT_MSG],
        paramsJson: '{"max_tokens":65}',
      }),
      headers: {},
      adapterId: anthropic,
      door: 'A',
      sessionModels: [],
    });

    expect(result.role).not.toBe('utility');
  });

  test('tools=[] AND max_tokens=16 AND messages=4 → NOT utility (too many messages)', () => {
    const result = classifyCallRole({
      request: req({
        tools: [],
        messages: [TEXT_MSG, TEXT_MSG, TEXT_MSG, TEXT_MSG],
        paramsJson: '{"max_tokens":16}',
      }),
      headers: {},
      adapterId: anthropic,
      door: 'A',
      sessionModels: [],
    });

    expect(result.role).not.toBe('utility');
  });

  test('full request with tools and large budget → main, inferred', () => {
    const result = classifyCallRole({
      request: req({
        tools: [TOOL_DEF, TOOL_DEF],
        messages: [TEXT_MSG, TEXT_MSG, TEXT_MSG, TEXT_MSG, TEXT_MSG],
        paramsJson: '{"max_tokens":8192}',
        model: 'claude-opus-5',
      }),
      headers: {},
      adapterId: anthropic,
      door: 'A',
      sessionModels: ['claude-opus-5'],
    });

    expect(result.role).toBe('main');
    expect(result.source).toBe('inferred');
  });
});

describe('classifyCallRole — Claude Code Sonnet-under-Opus subagent signal (refined CV)', () => {
  const anthropic = 'anthropic';

  test('sonnet model + opus in session + tools + real budget → subagent', () => {
    const result = classifyCallRole({
      request: req({
        model: 'claude-sonnet-5',
        tools: [TOOL_DEF],
        messages: [TEXT_MSG, TEXT_MSG, TEXT_MSG, TEXT_MSG],
        paramsJson: '{"max_tokens":4096}',
      }),
      headers: {},
      adapterId: anthropic,
      door: 'A',
      sessionModels: ['claude-opus-5'],
    });

    expect(result.role).toBe('subagent');
    expect(result.source).toBe('inferred');
    expect(result.evidence.some((e) => e.includes('sonnet'))).toBe(true);
    expect(result.evidence).toContain('session-has-opus');
    expect(result.evidence).toContain('has-tools');
  });

  test('sonnet model + opus in session + NO tools → NOT subagent (refined CV rule)', () => {
    // CV refuted naive Sonnet-under-Opus; without tools it is utility traffic.
    const result = classifyCallRole({
      request: req({
        model: 'claude-sonnet-5',
        tools: [],
        messages: [TEXT_MSG, TEXT_MSG],
        paramsJson: '{"max_tokens":16}',
      }),
      headers: {},
      adapterId: anthropic,
      door: 'A',
      sessionModels: ['claude-opus-5'],
    });

    // Matches utility fingerprint first (no tools + tiny budget)
    expect(result.role).toBe('utility');
    expect(result.role).not.toBe('subagent');
  });

  test('sonnet model, NO opus in session → main (not a subagent)', () => {
    const result = classifyCallRole({
      request: req({
        model: 'claude-sonnet-5',
        tools: [TOOL_DEF],
        messages: [TEXT_MSG, TEXT_MSG, TEXT_MSG],
        paramsJson: '{"max_tokens":4096}',
      }),
      headers: {},
      adapterId: anthropic,
      door: 'A',
      sessionModels: ['claude-sonnet-5'],
    });

    expect(result.role).toBe('main');
  });
});

// ---------------------------------------------------------------------------
// classifyCallRole — Gemini (not inferrable)
// ---------------------------------------------------------------------------

describe('classifyCallRole — Gemini', () => {
  test('always returns unknown, inferred', () => {
    const result = classifyCallRole({
      request: req({ tools: [TOOL_DEF], messages: [TEXT_MSG] }),
      headers: {},
      adapterId: 'gemini',
      door: 'B',
      sessionModels: [],
    });

    expect(result.role).toBe('unknown');
    expect(result.source).toBe('inferred');
    expect(result.evidence).toContain('gemini-wire-undifferentiated');
  });

  test('Gemini with tools and large budget still returns unknown — no guessing', () => {
    const result = classifyCallRole({
      request: req({
        model: 'gemini-pro',
        tools: [TOOL_DEF, TOOL_DEF],
        messages: [TEXT_MSG, TEXT_MSG, TEXT_MSG],
        paramsJson: '{"max_tokens":8192}',
      }),
      headers: {},
      adapterId: 'gemini',
      door: 'B',
      sessionModels: ['gemini-pro'],
    });

    expect(result.role).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// classifyCallRole — fallback
// ---------------------------------------------------------------------------

describe('classifyCallRole — fallback', () => {
  test('unknown adapterId → unknown, inferred', () => {
    const result = classifyCallRole({
      request: req(),
      headers: {},
      adapterId: 'future-adapter',
      door: 'A',
      sessionModels: [],
    });

    expect(result.role).toBe('unknown');
    expect(result.source).toBe('inferred');
    expect(result.evidence.some((e) => e.includes('future-adapter'))).toBe(true);
  });
});
