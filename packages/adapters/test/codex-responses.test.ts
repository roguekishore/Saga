import { describe, expect, test } from 'bun:test';
import type { SseFrame } from '@saga/contracts';
import { codexResponsesAdapter } from '../src/codex-responses';

const adapter = codexResponsesAdapter({ usageSource: 'gateway-computed' });

function frame(eventType: string, data: Record<string, unknown>): SseFrame {
  const json = { type: eventType, ...data };
  return { event: eventType, data: JSON.stringify(json), json };
}

const ctx = (body: unknown, headers: Record<string, string> = {}, path = '/v1/responses') => ({
  method: 'POST',
  path,
  headers,
  body,
});

// ---------------------------------------------------------------------------
// matches()
// ---------------------------------------------------------------------------

describe('matches()', () => {
  test('accepts /v1/responses', () => {
    expect(adapter.matches(ctx({}, {}, '/v1/responses'))).toBe(true);
  });

  test('accepts path ending in /responses without /v1 prefix', () => {
    expect(adapter.matches(ctx({}, {}, '/responses'))).toBe(true);
  });

  test('accepts path with non-standard prefix', () => {
    expect(adapter.matches(ctx({}, {}, '/proxy/v1/responses'))).toBe(true);
  });

  test('rejects /v1/chat/completions', () => {
    expect(adapter.matches(ctx({}, {}, '/v1/chat/completions'))).toBe(false);
  });

  test('rejects /v1/messages', () => {
    expect(adapter.matches(ctx({}, {}, '/v1/messages'))).toBe(false);
  });

  test('rejects /v1/messages with prefix', () => {
    expect(adapter.matches(ctx({}, {}, '/proxy/v1/messages'))).toBe(false);
  });

  test('rejects non-POST methods', () => {
    expect(adapter.matches({ method: 'GET', path: '/v1/responses', headers: {}, body: {} })).toBe(
      false,
    );
  });

  test('matches even when originator header is absent', () => {
    // originator: codex_cli_rs is only sent when non-default; absence must NOT
    // prevent matching — a matcher that requires it drops real traffic.
    const c = { method: 'POST', path: '/v1/responses', headers: {}, body: {} };
    expect(adapter.matches(c)).toBe(true);
  });

  test('still matches when originator header IS present', () => {
    const c = {
      method: 'POST',
      path: '/v1/responses',
      headers: { originator: 'codex_cli_rs' },
      body: {},
    };
    expect(adapter.matches(c)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// normalizeRequest() — identity / session
// ---------------------------------------------------------------------------

describe('normalizeRequest() — session identity', () => {
  /**
   * THE critical test: session id lives in the body, NOT the header.
   * The `session-id` header is the prompt-cache key (FINDINGS §1.4).
   * This test is written to fail loudly if someone "simplifies" the adapter
   * to read the header — the two values are intentionally different.
   */
  test('reads clientSessionId from body.client_metadata.session_id, NOT the session-id header', () => {
    const r = adapter.normalizeRequest(
      ctx(
        {
          model: 'codex-mini-latest',
          input: [],
          client_metadata: {
            session_id: 'body-session-uuid',
            thread_id: 'thread-uuid',
            turn_id: 'turn-uuid',
          },
        },
        { 'session-id': 'CACHE-KEY-NOT-SESSION' },
      ),
    );

    // Must use the body value, not the header value.
    expect(r.clientSessionId).toBe('body-session-uuid');
    expect(r.clientSessionId).not.toBe('CACHE-KEY-NOT-SESSION');
  });

  test('populates harnessIdentity from client_metadata body fields', () => {
    const r = adapter.normalizeRequest(
      ctx({
        model: 'codex-mini-latest',
        input: [],
        client_metadata: {
          session_id: 'sess-1',
          thread_id: 'thread-1',
          turn_id: 'turn-1',
          parent_turn_id: 'parent-turn-1',
        },
      }),
    );

    expect(r.harnessIdentity).toEqual({
      sessionId: 'sess-1',
      threadId: 'thread-1',
      turnId: 'turn-1',
      parentTurnId: 'parent-turn-1',
    });
  });

  test('harnessIdentity fields are null when client_metadata is absent', () => {
    const r = adapter.normalizeRequest(ctx({ model: 'm', input: [] }));
    expect(r.harnessIdentity?.sessionId).toBeNull();
    expect(r.harnessIdentity?.threadId).toBeNull();
    expect(r.harnessIdentity?.turnId).toBeNull();
    expect(r.harnessIdentity?.parentTurnId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// normalizeRequest() — routing tier
// ---------------------------------------------------------------------------

describe('normalizeRequest() — routingTier', () => {
  test('surfaces service_tier: priority', () => {
    const r = adapter.normalizeRequest(ctx({ model: 'm', input: [], service_tier: 'priority' }));
    expect(r.routingTier).toBe('priority');
  });

  test('surfaces service_tier: flex', () => {
    const r = adapter.normalizeRequest(ctx({ model: 'm', input: [], service_tier: 'flex' }));
    expect(r.routingTier).toBe('flex');
  });

  test('routingTier is null when service_tier is absent', () => {
    const r = adapter.normalizeRequest(ctx({ model: 'm', input: [] }));
    expect(r.routingTier).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// normalizeRequest() — input item mapping
// ---------------------------------------------------------------------------

describe('normalizeRequest() — input item types', () => {
  test('maps message items to NormalizedMessages', () => {
    const r = adapter.normalizeRequest(
      ctx({
        model: 'm',
        instructions: 'be terse',
        input: [
          { type: 'message', role: 'user', content: 'hello' },
          { type: 'message', role: 'assistant', content: 'hi' },
          { type: 'message', role: 'user', content: 'follow-up' },
        ],
      }),
    );

    // System prompt from `instructions`.
    expect(r.system[0]?.blocks[0]).toEqual({ type: 'text', text: 'be terse' });
    expect(r.messages.length).toBe(3);
    expect(r.messages[0]?.role).toBe('user');
    expect(r.messages[1]?.role).toBe('assistant');
    expect(r.messages[2]?.role).toBe('user');
  });

  test('maps function_call item to assistant message with tool_use block', () => {
    const r = adapter.normalizeRequest(
      ctx({
        model: 'm',
        input: [
          { type: 'message', role: 'user', content: 'list files' },
          {
            type: 'function_call',
            call_id: 'call-abc',
            name: 'Bash',
            // arguments is a JSON-encoded string per FINDINGS §1.5
            arguments: '{"cmd":"ls -la"}',
          },
        ],
      }),
    );

    const funcMsg = r.messages.find((m) => m.blocks.some((b) => b.type === 'tool_use'));
    expect(funcMsg).toBeDefined();
    expect(funcMsg?.role).toBe('assistant');
    const block = funcMsg?.blocks[0];
    expect(block?.type).toBe('tool_use');
    if (block?.type === 'tool_use') {
      expect(block.id).toBe('call-abc');
      expect(block.name).toBe('Bash');
      expect(block.input).toEqual({ cmd: 'ls -la' });
      expect(block.inputJson).toBe('{"cmd":"ls -la"}');
    }
  });

  test('maps function_call_output as TOP-LEVEL tool result, not a user message', () => {
    // This is the key distinction: Codex tool results are top-level items,
    // unlike Gemini where they nest inside a Content.
    const r = adapter.normalizeRequest(
      ctx({
        model: 'm',
        input: [
          { type: 'message', role: 'user', content: 'run ls' },
          {
            type: 'function_call',
            call_id: 'call-1',
            name: 'Bash',
            arguments: '{"cmd":"ls"}',
          },
          {
            type: 'function_call_output',
            call_id: 'call-1',
            output: 'file1.txt\nfile2.txt',
          },
        ],
      }),
    );

    const toolMsg = r.messages.find((m) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect(toolMsg?.role).toBe('tool');
    expect(toolMsg?.contextSource).toBe('tool');

    const block = toolMsg?.blocks[0];
    expect(block?.type).toBe('tool_result');
    if (block?.type === 'tool_result') {
      expect(block.toolUseId).toBe('call-1');
      expect(block.isError).toBe(false);
      expect(block.content[0]).toEqual({ type: 'text', text: 'file1.txt\nfile2.txt' });
    }

    // Must NOT appear as a user message.
    const userMsgs = r.messages.filter(
      (m) => m.role === 'user' && m.blocks.some((b) => b.type === 'tool_result'),
    );
    expect(userMsgs.length).toBe(0);
  });

  test('maps reasoning item with encrypted_content to redacted_thinking block', () => {
    const r = adapter.normalizeRequest(
      ctx({
        model: 'm',
        input: [
          { type: 'message', role: 'user', content: 'think hard' },
          {
            type: 'reasoning',
            id: 'rs_1',
            encrypted_content: 'OPAQUE_BLOB_FROM_OPENAI',
            summary: [],
          },
        ],
      }),
    );

    const reasonMsg = r.messages.find((m) => m.blocks.some((b) => b.type === 'redacted_thinking'));
    expect(reasonMsg).toBeDefined();
    const block = reasonMsg?.blocks[0];
    expect(block?.type).toBe('redacted_thinking');
    if (block?.type === 'redacted_thinking') {
      expect(block.data).toBe('OPAQUE_BLOB_FROM_OPENAI');
    }
  });

  test('maps reasoning item with summary but no encrypted_content to thinking block', () => {
    const r = adapter.normalizeRequest(
      ctx({
        model: 'm',
        input: [
          { type: 'message', role: 'user', content: 'think' },
          {
            type: 'reasoning',
            id: 'rs_2',
            summary: [{ type: 'summary_text', text: 'I considered several options' }],
          },
        ],
      }),
    );

    const reasonMsg = r.messages.find((m) => m.blocks.some((b) => b.type === 'thinking'));
    expect(reasonMsg).toBeDefined();
    const block = reasonMsg?.blocks[0];
    expect(block?.type).toBe('thinking');
    if (block?.type === 'thinking') {
      expect(block.thinking).toBe('I considered several options');
    }
  });
});

// ---------------------------------------------------------------------------
// normalizeRequest() — injection detection
// ---------------------------------------------------------------------------

describe('normalizeRequest() — injection tags', () => {
  test('detects user_instructions tag in user message content', () => {
    const r = adapter.normalizeRequest(
      ctx({
        model: 'm',
        input: [
          {
            type: 'message',
            role: 'user',
            content: '<user_instructions>Always answer in English.</user_instructions>\nHello',
          },
        ],
      }),
    );

    const tag = r.injections?.find((t) => t.type === 'user_instructions');
    expect(tag).toBeDefined();
  });

  test('detects environment_context tag in user message content', () => {
    const r = adapter.normalizeRequest(
      ctx({
        model: 'm',
        input: [
          {
            type: 'message',
            role: 'user',
            content:
              '<environment_context><cwd>/home/user/project</cwd><shell>bash</shell></environment_context>',
          },
        ],
      }),
    );

    const tag = r.injections?.find((t) => t.type === 'environment_context');
    expect(tag).toBeDefined();
    // Must NOT be tagged as a diff when a full block.
    const diffTag = r.injections?.find((t) => t.type === 'environment_context:diff');
    expect(diffTag).toBeUndefined();
  });

  test('detects environment_context:diff for partial environment block', () => {
    // A diff block carries status="unavailable" for disappeared environments
    // or lacks the <cwd> field that full renders always include.
    const r = adapter.normalizeRequest(
      ctx({
        model: 'm',
        input: [
          {
            type: 'message',
            role: 'user',
            content:
              '<environment_context><environment id="main" status="unavailable" /></environment_context>',
          },
        ],
      }),
    );

    const diffTag = r.injections?.find((t) => t.type === 'environment_context:diff');
    expect(diffTag).toBeDefined();
    // Must surface with detail indicating partial nature.
    expect(diffTag?.detail).toContain('partial');
  });

  test('detects reasoning_encrypted injection for reasoning items with encrypted_content', () => {
    const r = adapter.normalizeRequest(
      ctx({
        model: 'm',
        input: [
          { type: 'message', role: 'user', content: 'hi' },
          { type: 'reasoning', encrypted_content: 'BLOB' },
        ],
      }),
    );

    const tag = r.injections?.find((t) => t.type === 'reasoning_encrypted');
    expect(tag).toBeDefined();
  });

  test('detects compaction injection for compaction item type', () => {
    const r = adapter.normalizeRequest(
      ctx({
        model: 'm',
        input: [{ type: 'message', role: 'user', content: 'hi' }, { type: 'compaction' }],
      }),
    );

    const tag = r.injections?.find((t) => t.type === 'compaction');
    expect(tag).toBeDefined();
  });

  test('detects responses_lite_prefix from header', () => {
    const r = adapter.normalizeRequest(
      ctx({ model: 'm', input: [] }, { 'x-openai-internal-codex-responses-lite': 'true' }),
    );

    const tag = r.injections?.find((t) => t.type === 'responses_lite_prefix');
    expect(tag).toBeDefined();
  });

  test('no injections on a clean minimal request', () => {
    const r = adapter.normalizeRequest(
      ctx({
        model: 'm',
        input: [{ type: 'message', role: 'user', content: 'hello' }],
      }),
    );

    expect(r.injections).toBeDefined();
    expect(r.injections?.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// normalizeRequest() — malformed / edge cases
// ---------------------------------------------------------------------------

describe('normalizeRequest() — robustness', () => {
  test('does not throw on an empty body', () => {
    expect(() => adapter.normalizeRequest(ctx({}))).not.toThrow();
  });

  test('does not throw on null body', () => {
    expect(() => adapter.normalizeRequest(ctx(null))).not.toThrow();
  });

  test('does not throw on undefined body', () => {
    expect(() => adapter.normalizeRequest(ctx(undefined))).not.toThrow();
  });

  test('does not throw on completely alien body shape', () => {
    expect(() =>
      adapter.normalizeRequest(ctx({ totally: 'unexpected', nested: { value: [1, 2, 3] } })),
    ).not.toThrow();
  });

  test('handles missing client_metadata gracefully', () => {
    const r = adapter.normalizeRequest(ctx({ model: 'm', input: [] }));
    expect(r.clientSessionId).toBeNull();
  });

  test('handles non-array input gracefully', () => {
    const r = adapter.normalizeRequest(ctx({ model: 'm', input: 'not an array' }));
    expect(r.messages).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// normalizeRequest() — full realistic shape
// ---------------------------------------------------------------------------

describe('normalizeRequest() — realistic full body', () => {
  test('normalizes a complete multi-turn body without throwing', () => {
    const r = adapter.normalizeRequest(
      ctx(
        {
          model: 'codex-mini-latest',
          instructions: 'You are a helpful coding assistant.',
          stream: true,
          store: false,
          tool_choice: 'auto',
          parallel_tool_calls: true,
          service_tier: 'flex',
          reasoning: { effort: 'medium', summary: 'auto' },
          include: ['reasoning.encrypted_content'],
          client_metadata: {
            session_id: 'session-abc',
            thread_id: 'thread-xyz',
            turn_id: 'turn-001',
          },
          tools: [
            {
              type: 'function',
              name: 'Bash',
              description: 'Run a shell command',
              parameters: { type: 'object', properties: { cmd: { type: 'string' } } },
            },
          ],
          input: [
            {
              type: 'message',
              role: 'user',
              content:
                '<environment_context><cwd>/proj</cwd><shell>bash</shell></environment_context>\nList files',
            },
            {
              type: 'function_call',
              call_id: 'c1',
              name: 'Bash',
              arguments: '{"cmd":"ls"}',
            },
            {
              type: 'function_call_output',
              call_id: 'c1',
              output: 'README.md\nsrc/',
            },
            { type: 'message', role: 'assistant', content: 'Here are the files.' },
            { type: 'message', role: 'user', content: 'show contents of README' },
          ],
        },
        {},
      ),
    );

    expect(r.model).toBe('codex-mini-latest');
    expect(r.stream).toBe(true);
    expect(r.system.length).toBe(1);
    expect(r.clientSessionId).toBe('session-abc');
    expect(r.routingTier).toBe('flex');
    expect(r.harnessIdentity?.sessionId).toBe('session-abc');
    expect(r.harnessIdentity?.threadId).toBe('thread-xyz');
    expect(r.harnessIdentity?.turnId).toBe('turn-001');
    expect(r.tools.length).toBe(1);
    expect(r.tools[0]?.name).toBe('Bash');
    // Injections: environment_context from user message.
    const envTag = r.injections?.find((t) => t.type === 'environment_context');
    expect(envTag).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Stream observer
// ---------------------------------------------------------------------------

describe('CodexResponsesObserver', () => {
  test('registers completion on response.completed frame and reads usage', () => {
    const o = adapter.createObserver();

    o.onFrame(frame('response.output_text.delta', { delta: { type: 'text_delta', text: 'hi' } }));
    expect(o.sawFirstContent()).toBe(true);

    o.onFrame(
      frame('response.completed', {
        response: {
          id: 'resp_1',
          status: 'completed',
          usage: {
            input_tokens: 1024,
            output_tokens: 128,
            input_tokens_details: {
              cached_tokens: 512,
              cache_write_tokens: 256,
            },
          },
        },
      }),
    );

    const r = o.finalize('complete');
    expect(r.usage.input).toEqual({ value: 1024, source: 'gateway-computed' });
    expect(r.usage.output).toEqual({ value: 128, source: 'gateway-computed' });
    expect(r.usage.cacheRead).toEqual({ value: 512, source: 'gateway-computed' });
    expect(r.usage.cacheWrite).toEqual({ value: 256, source: 'gateway-computed' });
    expect(r.stopReason).toBe('completed');
    expect(r.frameStats.frames).toBe(2);
    expect(r.frameStats.parseErrors).toBe(0);
  });

  test('stream cut before response.completed leaves usage null', () => {
    const o = adapter.createObserver();

    o.onFrame(frame('response.output_text.delta', { delta: { text: 'partial' } }));
    // No response.completed — stream was cut.

    const r = o.finalize('client_aborted');
    expect(r.usage.input).toBeNull();
    expect(r.usage.output).toBeNull();
    expect(r.stopReason).toBe('client_aborted');
  });

  test('response.failed sets stop reason from error code', () => {
    const o = adapter.createObserver();

    o.onFrame(
      frame('response.failed', {
        response: {
          error: { code: 'rate_limit_exceeded', message: 'Rate limit hit' },
        },
      }),
    );

    const r = o.finalize('upstream_error');
    expect(r.stopReason).toBe('rate_limit_exceeded');
  });

  test('response.incomplete sets stop reason', () => {
    const o = adapter.createObserver();

    o.onFrame(
      frame('response.incomplete', {
        response: {
          incomplete_details: { reason: 'max_output_tokens' },
        },
      }),
    );

    const r = o.finalize('upstream_error');
    expect(r.stopReason).toBe('max_output_tokens');
  });

  test('tracks tool uses from response.output_item.done', () => {
    const o = adapter.createObserver();

    o.onFrame(
      frame('response.output_item.done', {
        item: {
          type: 'function_call',
          call_id: 'call-99',
          name: 'Bash',
          arguments: '{"cmd":"pwd"}',
        },
      }),
    );
    o.onFrame(frame('response.completed', { response: { usage: {} } }));

    const r = o.finalize('complete');
    expect(r.toolUses.length).toBe(1);
    expect(r.toolUses[0]?.toolUseId).toBe('call-99');
    expect(r.toolUses[0]?.name).toBe('Bash');
    expect(r.toolUses[0]?.inputJson).toBe('{"cmd":"pwd"}');
  });

  test('sawFirstContent() is false before any content frame', () => {
    const o = adapter.createObserver();

    o.onFrame(frame('response.created', { response: { id: 'r1' } }));
    o.onFrame(frame('response.in_progress', {}));

    expect(o.sawFirstContent()).toBe(false);
  });

  test('frame stats count all frames including non-content', () => {
    const o = adapter.createObserver();

    o.onFrame(frame('response.created', {}));
    o.onFrame(frame('response.output_text.delta', { delta: { text: 'a' } }));
    o.onFrame(frame('response.completed', { response: { usage: {} } }));

    const r = o.finalize('complete');
    expect(r.frameStats.frames).toBe(3);
  });

  test('provenance is gateway-computed, never upstream-reported', () => {
    const o = adapter.createObserver();

    o.onFrame(
      frame('response.completed', {
        response: {
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      }),
    );

    const r = o.finalize('complete');
    // Door A goes through CONDUIT — provenance is gateway-computed.
    expect(r.usage.input?.source).toBe('gateway-computed');
    expect(r.usage.output?.source).toBe('gateway-computed');
  });
});
