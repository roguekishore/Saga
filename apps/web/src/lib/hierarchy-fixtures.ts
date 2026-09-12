import type { Exchange, InjectionTag, TurnDetail, TurnSummary } from '@saga/contracts';

/**
 * Fixtures for the hierarchy view. Shaped from FROZEN contract schemas in
 * `@saga/contracts/readapi.ts`. Covers the states a naive implementation gets
 * wrong — each is a case where the honest rendering differs from the obvious one.
 */

// ---------------------------------------------------------------- shared helpers

const now = Date.now();
const s = (offsetSec: number) => now - offsetSec * 1000;

// ---------------------------------------------------------------- turn 1: single exchange, harness-declared boundary

const exchange1_1: Exchange = {
  requestId: 'req-a1b2c3d4',
  ts: s(120),
  seqInTurn: 0,
  door: 'A',
  harness: 'codex',
  model: 'gpt-4o',
  callRole: 'main',
  callRoleSource: 'harness-declared',
  callRoleEvidence: ['x-openai-turn-id header present', 'role=main stated in metadata'],
  routingTier: 'tier-1',
  status: 'ok',
  latencyMs: 1240,
  ttftMs: 340,
  usage: {
    input: { value: 4218, source: 'upstream-reported' },
    output: { value: 312, source: 'upstream-reported' },
    cacheRead: null,
    cacheWrite: null,
    thought: null,
    total: { value: 4530, source: 'upstream-reported' },
  },
  credits: 0.014,
  contextUsagePercentage: 6.5,
  stopReason: 'end_turn',
  metricsSource: 'conduit-seam',
  seamStatus: 'present',
  replyPreview: 'I can help you refactor that module. Let me start by reading the file.',
  toolCalls: [],
  injections: [
    {
      seq: 0,
      type: 'system_prompt',
      location: 'system',
      source: 'conduit-declared',
      detail: 'Injected by CONDUIT before forwarding to upstream',
    },
    {
      seq: 1,
      type: 'workspace_context',
      location: 'user[0]',
      source: 'saga-observed',
      detail: null,
    },
  ] satisfies InjectionTag[],
};

export const turn1Summary: TurnSummary = {
  turnId: 'turn-codex-single',
  sessionId: 'sess-demo-001',
  seq: 1,
  startedAt: s(125),
  endedAt: s(115),
  boundarySource: 'harness-declared',
  harnessTurnId: 'openai-turn-xyz',
  partial: false,
  evidence: [
    'x-openai-turn-id header present on all exchanges',
    'Consecutive turn IDs match session ordering',
  ],
  requestCount: 1,
  spanMs: 1380,
  inputTokens: { value: 4218, sources: ['upstream-reported'] },
  outputTokens: { value: 312, sources: ['upstream-reported'] },
  thoughtTokens: { value: 0, sources: [] },
  credits: 0.014,
  contextUsageReadings: [6.5],
  callRoles: ['main'],
  errors: 0,
};

// ---------------------------------------------------------------- turn 2: 30-exchange loop, inferred boundary, mixed provenance

function makeExchange(
  seq: number,
  role: Exchange['callRole'],
  roleSource: Exchange['callRoleSource'],
  seamStatus: Exchange['seamStatus'],
  door: Exchange['door'],
  ctxPct: number,
  injections: InjectionTag[],
): Exchange {
  return {
    requestId: `req-loop-${seq.toString().padStart(3, '0')}`,
    ts: s(3600 - seq * 110),
    seqInTurn: seq,
    door,
    harness: 'claude-code',
    model: 'claude-opus-4-5',
    callRole: role,
    callRoleSource: roleSource,
    callRoleEvidence:
      roleSource === 'inferred'
        ? [
            'No explicit role header; inferred from prompt shape',
            'Tool-use pattern matches utility call',
          ]
        : [`x-saga-call-role header: ${role}`],
    routingTier: 'tier-2',
    status: seq === 29 ? 'upstream_error' : 'ok',
    latencyMs: 900 + seq * 12,
    ttftMs: 200 + seq * 5,
    usage: {
      input: {
        value: 8000 + seq * 1200,
        source: seq % 3 === 0 ? 'upstream-reported' : 'gateway-computed',
      },
      output: {
        value: 400 + seq * 30,
        source: seq % 3 === 0 ? 'upstream-reported' : 'gateway-computed',
      },
      cacheRead: seq > 5 ? { value: seq * 800, source: 'upstream-reported' } : null,
      cacheWrite: null,
      thought: seq % 5 === 0 ? { value: seq * 60, source: 'upstream-reported' } : null,
      total: null,
    },
    credits: seq % 4 === 0 ? null : 0.03 + seq * 0.002,
    contextUsagePercentage: ctxPct,
    stopReason: seq === 29 ? 'max_tokens' : 'tool_use',
    metricsSource:
      door === 'B' ? 'gemini-native' : seamStatus === 'pending' ? null : 'conduit-seam',
    seamStatus,
    replyPreview:
      seq === 29 ? null : `Step ${seq + 1}: Calling tool to read file at path/to/module_${seq}.ts`,
    toolCalls:
      seq < 28 ? [{ toolUseId: `tu-${seq}`, name: seq % 2 === 0 ? 'read_file' : 'bash' }] : [],
    injections,
  };
}

// Build 30 exchanges with varied state
const loopExchanges: Exchange[] = Array.from({ length: 30 }, (_, i) => {
  const role: Exchange['callRole'] =
    i === 0 ? 'main' : i % 7 === 0 ? 'subagent' : i % 3 === 0 ? 'utility' : 'main';
  const roleSource: Exchange['callRoleSource'] = i === 0 ? 'harness-declared' : 'inferred';
  // Exchange 5: pending seam (Door A waiting for CONDUIT)
  // Exchange 15: not-applicable (simulating Gemini door)
  const seamStatus: Exchange['seamStatus'] =
    i === 5 ? 'pending' : i === 15 ? 'not-applicable' : 'present';
  const door: Exchange['door'] = i === 15 ? 'B' : 'A';
  // Context usage climbs from ~8% to ~78%
  const ctxPct = 8 + i * 2.3;

  const baseInjections: InjectionTag[] = [
    {
      seq: 0,
      type: 'system_prompt',
      location: 'system',
      source: 'conduit-declared',
      detail: 'CONDUIT system prompt injection',
    },
  ];

  // Exchange 10: environment_context:diff — the loud one
  if (i === 10) {
    baseInjections.push({
      seq: 1,
      type: 'environment_context:diff',
      location: 'user[0]',
      source: 'conduit-declared',
      detail:
        'Partial context diff: the model received only changed lines, not the full file. What the model knew is spread across several requests.',
    });
  }

  // Spread: some have saga-observed, some conduit-declared, some both
  if (i % 4 === 0) {
    baseInjections.push({
      seq: baseInjections.length,
      type: 'memory_block',
      location: 'user[0]',
      source: 'saga-observed',
      detail: null,
    });
  }
  if (i % 6 === 0) {
    baseInjections.push({
      seq: baseInjections.length,
      type: 'tool_result_context',
      location: 'user[1]',
      source: 'saga-observed',
      detail: null,
    });
  }

  return makeExchange(i, role, roleSource, seamStatus, door, ctxPct, baseInjections);
});

export const turn2Summary: TurnSummary = {
  turnId: 'turn-claude-loop',
  sessionId: 'sess-demo-001',
  seq: 2,
  startedAt: s(3700),
  endedAt: s(300),
  boundarySource: 'inferred',
  harnessTurnId: null,
  partial: false,
  evidence: [
    'No turn_id header on any exchange; boundary derived from idle-gap heuristic',
    'Claude Code session ID consistent across all 30 requests',
    '42-second gap before first exchange matched session idle threshold',
  ],
  requestCount: 30,
  spanMs: 3400 * 1000, // ~56 min loop
  inputTokens: { value: 412800, sources: ['upstream-reported', 'gateway-computed'] }, // mixed
  outputTokens: { value: 14760, sources: ['gateway-computed'] },
  thoughtTokens: { value: 3600, sources: ['upstream-reported'] },
  credits: null, // null — must render n/a, not 0
  contextUsageReadings: loopExchanges
    .map((e) => e.contextUsagePercentage)
    .filter((v): v is number => v !== null),
  callRoles: ['main', 'subagent', 'utility'],
  errors: 1,
};

// ---------------------------------------------------------------- turn 3: still open (endedAt: null)

const exchange3_1: Exchange = {
  requestId: 'req-open-001',
  ts: s(30),
  seqInTurn: 0,
  door: 'A',
  harness: 'claude-code',
  model: 'claude-sonnet-4-5',
  callRole: 'main',
  callRoleSource: 'inferred',
  callRoleEvidence: ['First exchange in turn, prompt contains direct user instruction'],
  routingTier: 'tier-1',
  status: null, // in-flight
  latencyMs: null,
  ttftMs: null,
  usage: {
    input: { value: 12400, source: 'gateway-computed' },
    output: null,
    cacheRead: null,
    cacheWrite: null,
    thought: null,
    total: null,
  },
  credits: null,
  contextUsagePercentage: null,
  stopReason: null,
  metricsSource: null,
  seamStatus: 'pending',
  replyPreview: null,
  toolCalls: [],
  injections: [
    {
      seq: 0,
      type: 'system_prompt',
      location: 'system',
      source: 'conduit-declared',
      detail: null,
    },
    {
      seq: 1,
      type: 'project_instructions',
      location: 'system',
      source: 'saga-observed',
      detail: 'CLAUDE.md content injected at system level',
    },
  ],
};

export const turn3Summary: TurnSummary = {
  turnId: 'turn-open-now',
  sessionId: 'sess-demo-001',
  seq: 3,
  startedAt: s(35),
  endedAt: null, // still open
  boundarySource: 'inferred',
  harnessTurnId: null,
  partial: false,
  evidence: ['Inferred start: 85-second gap from prior turn', 'Session ID matches active session'],
  requestCount: 1,
  spanMs: null,
  inputTokens: { value: 12400, sources: ['gateway-computed'] },
  outputTokens: { value: 0, sources: [] },
  thoughtTokens: { value: 0, sources: [] },
  credits: null,
  contextUsageReadings: [],
  callRoles: ['main'],
  errors: 0,
};

// ---------------------------------------------------------------- turn 4: partial (capture began mid-loop)

const exchange4_1: Exchange = {
  requestId: 'req-partial-001',
  ts: s(7200),
  seqInTurn: 0,
  door: 'A',
  harness: 'gemini-cli',
  model: 'gemini-2.5-pro',
  callRole: 'unknown',
  callRoleSource: 'inferred',
  callRoleEvidence: [
    'Capture began mid-loop; prior context window unknown',
    'Unable to determine role from truncated exchange sequence',
  ],
  routingTier: null,
  status: 'ok',
  latencyMs: 2100,
  ttftMs: 450,
  usage: {
    input: { value: 98400, source: 'upstream-reported' },
    output: { value: 1820, source: 'upstream-reported' },
    cacheRead: null, // Gemini — n/a
    cacheWrite: null,
    thought: { value: 3200, source: 'upstream-reported' },
    total: { value: 103420, source: 'upstream-reported' },
  },
  credits: null, // Gemini — n/a by design
  contextUsagePercentage: 74.2,
  stopReason: 'end_turn',
  metricsSource: 'gemini-native',
  seamStatus: 'not-applicable', // Gemini — will never have a seam
  replyPreview: 'Based on the context so far, I recommend splitting the component into…',
  toolCalls: [],
  injections: [
    {
      seq: 0,
      type: 'environment_context:diff',
      location: 'user[0]',
      source: 'conduit-declared',
      detail:
        'Partial context diff — model received incremental file changes across multiple requests. Single-request interpretation is incomplete.',
    },
    {
      seq: 1,
      type: 'shell_snapshot',
      location: 'user[0]',
      source: 'saga-observed',
      detail: null,
    },
  ],
};

export const turn4Summary: TurnSummary = {
  turnId: 'turn-partial-gemini',
  sessionId: 'sess-demo-001',
  seq: 4,
  startedAt: s(8000),
  endedAt: s(7100),
  boundarySource: 'inferred',
  harnessTurnId: null,
  partial: true, // capture began mid-loop — honest, not short
  evidence: [
    'SAGA started recording partway through this instruction',
    'Context usage at 74% on first observed exchange — prior exchanges unrecorded',
    'No opening exchange with low context pct found; turn is genuinely incomplete',
  ],
  requestCount: 1,
  spanMs: 2200,
  inputTokens: { value: 98400, sources: ['upstream-reported'] },
  outputTokens: { value: 1820, sources: ['upstream-reported'] },
  thoughtTokens: { value: 3200, sources: ['upstream-reported'] },
  credits: null, // Gemini — n/a
  contextUsageReadings: [74.2],
  callRoles: ['unknown'],
  errors: 0,
};

// ---------------------------------------------------------------- assembled fixtures

export const HIERARCHY_FIXTURES: {
  turns: TurnSummary[];
  details: TurnDetail[];
} = {
  turns: [turn4Summary, turn3Summary, turn2Summary, turn1Summary],
  details: [
    { turn: turn1Summary, exchanges: [exchange1_1] },
    { turn: turn2Summary, exchanges: loopExchanges },
    { turn: turn3Summary, exchanges: [exchange3_1] },
    { turn: turn4Summary, exchanges: [exchange4_1] },
  ],
};

export const EMPTY_EXCHANGES: Exchange[] = [];
