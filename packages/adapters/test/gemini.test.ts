import { describe, expect, test } from 'bun:test';
import type { SseFrame } from '@saga/contracts';
import { geminiAdapter } from '../src/gemini';

const opts = { usageSource: 'upstream-reported' as const };
const adapter = geminiAdapter(opts);

// ---------------------------------------------------------------------------
// Context builders
// ---------------------------------------------------------------------------

function ctx(path: string, body: unknown, headers: Record<string, string> = {}) {
  return { method: 'POST', path, headers, body };
}

const VERTEX_PATH =
  '/v1beta1/publishers/google/models/gemini-2.0-flash:streamGenerateContent?alt=sse';

const VERTEX_HEADERS = { 'x-goog-api-key': 'test-key' };

function vertexCtx(body: unknown, headers = VERTEX_HEADERS) {
  return ctx(VERTEX_PATH, body, headers);
}

function frame(json: Record<string, unknown>): SseFrame {
  return { event: null, data: JSON.stringify(json), json };
}

// ---------------------------------------------------------------------------
// matches()
// ---------------------------------------------------------------------------

describe('gemini matches()', () => {
  test('accepts Vertex URL with x-goog-api-key', () => {
    expect(adapter.matches(ctx(VERTEX_PATH, null, { 'x-goog-api-key': 'key' }))).toBe(true);
  });

  test('accepts Vertex URL with GeminiCLI User-Agent (no api-key header)', () => {
    expect(
      adapter.matches(
        ctx(VERTEX_PATH, null, {
          'user-agent': 'GeminiCLI/1.2.3/gemini-2.0-flash (linux; x64; cli)',
        }),
      ),
    ).toBe(true);
  });

  test('accepts VS Code variant via proxy_client=geminicli', () => {
    expect(
      adapter.matches(
        ctx(VERTEX_PATH, null, {
          'user-agent': 'CloudCodeVSCode/1.0 (aidev_client; proxy_client=geminicli)',
        }),
      ),
    ).toBe(true);
  });

  test('accepts unary (non-stream) Vertex path', () => {
    expect(
      adapter.matches(
        ctx('/v1beta1/publishers/google/models/gemini-pro:generateContent', null, {
          'x-goog-api-key': 'key',
        }),
      ),
    ).toBe(true);
  });

  test('rejects Anthropic path', () => {
    expect(adapter.matches(ctx('/v1/messages', null, { 'x-goog-api-key': 'key' }))).toBe(false);
  });

  test('rejects OpenAI path', () => {
    expect(adapter.matches(ctx('/v1/chat/completions', null, { 'x-goog-api-key': 'key' }))).toBe(
      false,
    );
  });

  test('rejects Codex /responses path', () => {
    expect(adapter.matches(ctx('/v1/responses', null, { 'x-goog-api-key': 'key' }))).toBe(false);
  });

  test('rejects door-A v1internal path (colon-method but wrong prefix)', () => {
    // Door A: cloudcode-pa.googleapis.com/v1internal:streamGenerateContent
    // SAGA would only see the path portion.
    expect(
      adapter.matches(ctx('/v1internal:streamGenerateContent', null, { 'x-goog-api-key': 'key' })),
    ).toBe(false);
  });

  test('rejects Vertex path with no auth signal', () => {
    // path is correct but no api-key and no Gemini UA
    expect(adapter.matches(ctx(VERTEX_PATH, null, {}))).toBe(false);
  });

  test('case-insensitive header name for x-goog-api-key', () => {
    expect(adapter.matches(ctx(VERTEX_PATH, null, { 'X-Goog-Api-Key': 'key' }))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// normalizeRequest()
// ---------------------------------------------------------------------------

describe('gemini normalizeRequest()', () => {
  test('model is extracted from URL, not body', () => {
    const r = adapter.normalizeRequest(
      vertexCtx({
        // No model field in body — Gemini puts it in the URL.
        contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      }),
    );
    expect(r.model).toBe('gemini-2.0-flash');
  });

  test('stream is detected from :streamGenerateContent in path', () => {
    const r = adapter.normalizeRequest(vertexCtx({ contents: [] }));
    expect(r.stream).toBe(true);

    const r2 = adapter.normalizeRequest(
      ctx(
        '/v1beta1/publishers/google/models/gemini-pro:generateContent',
        { contents: [] },
        VERTEX_HEADERS,
      ),
    );
    expect(r2.stream).toBe(false);
  });

  test('systemInstruction parts map to system messages', () => {
    const r = adapter.normalizeRequest(
      vertexCtx({
        systemInstruction: {
          role: 'user',
          parts: [{ text: 'You are a helpful assistant.' }],
        },
        contents: [],
      }),
    );
    expect(r.system).toHaveLength(1);
    expect(r.system[0]?.blocks[0]).toEqual({ type: 'text', text: 'You are a helpful assistant.' });
    expect(r.system[0]?.contextSource).toBe('system');
  });

  test('simple user → assistant → user conversation', () => {
    const r = adapter.normalizeRequest(
      vertexCtx({
        contents: [
          { role: 'user', parts: [{ text: 'first turn' }] },
          { role: 'model', parts: [{ text: 'reply' }] },
          { role: 'user', parts: [{ text: 'second turn' }] },
        ],
      }),
    );
    expect(r.messages).toHaveLength(3);
    expect(r.messages[0]?.role).toBe('user');
    expect(r.messages[1]?.role).toBe('assistant');
    expect(r.messages[2]?.role).toBe('user');
    expect(r.messages[0]?.contextSource).toBe('history');
    expect(r.messages[1]?.contextSource).toBe('history');
    expect(r.messages[2]?.contextSource).toBe('user');
  });

  test('functionResponse parts inside role:user → tool_result blocks (not user message)', () => {
    // THE SHAPE TRAP: tool results are parts inside a Content, NOT top-level items.
    const r = adapter.normalizeRequest(
      vertexCtx({
        contents: [
          { role: 'user', parts: [{ text: 'run ls' }] },
          {
            role: 'model',
            parts: [{ functionCall: { name: 'bash', args: { cmd: 'ls' } } }],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  name: 'bash',
                  response: { output: 'file-a\nfile-b' },
                },
              },
            ],
          },
        ],
      }),
    );
    expect(r.messages).toHaveLength(3);

    // The last message is the tool-result turn — it must NOT be classified as
    // a user message, because all its blocks are tool_result.
    const toolMsg = r.messages[2];
    expect(toolMsg?.contextSource).toBe('tool');
    expect(toolMsg?.blocks[0]?.type).toBe('tool_result');
    if (toolMsg?.blocks[0]?.type === 'tool_result') {
      expect(toolMsg.blocks[0].toolUseId).toBe('bash');
    }

    // The model turn has a tool_use block.
    const modelMsg = r.messages[1];
    expect(modelMsg?.blocks[0]?.type).toBe('tool_use');
    if (modelMsg?.blocks[0]?.type === 'tool_use') {
      expect(modelMsg.blocks[0].name).toBe('bash');
    }
  });

  test('thought part (thought:true) maps to thinking block', () => {
    const r = adapter.normalizeRequest(
      vertexCtx({
        contents: [
          {
            role: 'model',
            parts: [
              { text: 'I reason', thought: true, thoughtSignature: 'sig123' },
              { text: 'Here is my answer.' },
            ],
          },
        ],
      }),
    );
    const blocks = r.messages[0]?.blocks ?? [];
    expect(blocks[0]?.type).toBe('thinking');
    if (blocks[0]?.type === 'thinking') {
      expect(blocks[0].thinking).toBe('I reason');
      expect(blocks[0].signature).toBe('sig123');
    }
    expect(blocks[1]?.type).toBe('text');
  });

  test('functionDeclarations inside tools[] become ToolDefSummary entries', () => {
    const r = adapter.normalizeRequest(
      vertexCtx({
        contents: [],
        tools: [
          {
            functionDeclarations: [
              {
                name: 'read_file',
                description: 'read a file',
                parameters: { type: 'object', properties: { path: { type: 'string' } } },
              },
              {
                name: 'write_file',
                description: 'write a file',
                parameters: {
                  type: 'object',
                  properties: { path: { type: 'string' }, content: { type: 'string' } },
                },
              },
            ],
          },
        ],
      }),
    );
    expect(r.tools).toHaveLength(2);
    expect(r.tools[0]?.name).toBe('read_file');
    expect(r.tools[1]?.name).toBe('write_file');
    expect(r.tools[0]?.descriptionBytes).toBeGreaterThan(0);
  });

  test('syntheticSessionKey populated from x-gemini-api-privileged-user-id', () => {
    const r = adapter.normalizeRequest(
      ctx(
        VERTEX_PATH,
        { contents: [] },
        {
          'x-goog-api-key': 'key',
          'x-gemini-api-privileged-user-id': 'install-abc-123',
        },
      ),
    );
    expect(r.syntheticSessionKey).toBe('install-abc-123');
    // clientSessionId must remain null — this is an install id, not a session.
    expect(r.clientSessionId).toBeNull();
  });

  test('clientSessionId is always null (Vertex declares nothing session-scoped)', () => {
    const r = adapter.normalizeRequest(vertexCtx({ contents: [] }));
    expect(r.clientSessionId).toBeNull();
  });

  test('harnessIdentity is null (Gemini-Vertex declares no harness identity)', () => {
    const r = adapter.normalizeRequest(vertexCtx({ contents: [] }));
    expect(r.harnessIdentity).toBeNull();
  });

  test('routingTier from X-Vertex-AI-LLM-Request-Type header', () => {
    const r = adapter.normalizeRequest(
      ctx(
        VERTEX_PATH,
        { contents: [] },
        {
          'x-goog-api-key': 'key',
          'x-vertex-ai-llm-request-type': 'dedicated',
        },
      ),
    );
    expect(r.routingTier).toBe('dedicated');
  });

  test('routingTier combined from request-type + shared-request-type headers', () => {
    const r = adapter.normalizeRequest(
      ctx(
        VERTEX_PATH,
        { contents: [] },
        {
          'x-goog-api-key': 'key',
          'x-vertex-ai-llm-request-type': 'shared',
          'x-vertex-ai-llm-shared-request-type': 'flex',
        },
      ),
    );
    expect(r.routingTier).toBe('shared/flex');
  });

  test('injections: session_context detected from first content item', () => {
    const r = adapter.normalizeRequest(
      vertexCtx({
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: '<session_context>\nThis is the Gemini CLI. Today is Monday.\n</session_context>',
              },
            ],
          },
          { role: 'user', parts: [{ text: 'do something' }] },
        ],
      }),
    );
    const types = (r.injections ?? []).map((i) => i.type);
    expect(types).toContain('session_context');
    expect(types).not.toContain('session_context:folder_tree');
  });

  test('injections: session_context:folder_tree detected when nested marker present', () => {
    const r = adapter.normalizeRequest(
      vertexCtx({
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: '<session_context>\n<session_context:folder_tree>\nsrc/\n  index.ts\n</session_context:folder_tree>\n</session_context>',
              },
            ],
          },
        ],
      }),
    );
    const types = (r.injections ?? []).map((i) => i.type);
    expect(types).toContain('session_context');
    expect(types).toContain('session_context:folder_tree');
  });

  test('injections: vertex_routing_tier emitted when routing headers present', () => {
    const r = adapter.normalizeRequest(
      ctx(
        VERTEX_PATH,
        { contents: [] },
        {
          'x-goog-api-key': 'key',
          'x-vertex-ai-llm-request-type': 'shared',
          'x-vertex-ai-llm-shared-request-type': 'priority',
        },
      ),
    );
    const tier = (r.injections ?? []).find((i) => i.type === 'vertex_routing_tier');
    expect(tier).toBeDefined();
    expect(tier?.detail).toBe('shared/priority');
  });

  test('normalizeRequest does not throw on empty/null body', () => {
    expect(() => adapter.normalizeRequest(vertexCtx(null))).not.toThrow();
    expect(() => adapter.normalizeRequest(vertexCtx({}))).not.toThrow();
    expect(() => adapter.normalizeRequest(vertexCtx(undefined))).not.toThrow();
  });

  test('normalizeRequest does not throw on malformed contents', () => {
    expect(() =>
      adapter.normalizeRequest(
        vertexCtx({
          contents: [
            null,
            42,
            { role: 'user' /* no parts */ },
            { role: 'user', parts: null },
            { role: 'user', parts: [null, 'not an object', { unexpected: true }] },
          ],
        }),
      ),
    ).not.toThrow();
  });

  test('paramsJson contains generationConfig, not messages/system/tools', () => {
    const r = adapter.normalizeRequest(
      vertexCtx({
        contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
        generationConfig: { temperature: 0.7, thinkingConfig: { thinkingBudget: 1024 } },
      }),
    );
    const params = JSON.parse(r.paramsJson);
    expect(params.generationConfig).toBeDefined();
    expect(params.contents).toBeUndefined();
    expect(params.systemInstruction).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// GeminiObserver / finalize()
// ---------------------------------------------------------------------------

describe('GeminiObserver finalize()', () => {
  test('all six usageMetadata counters land in the right slots', () => {
    const o = adapter.createObserver();
    o.onFrame(
      frame({
        candidates: [
          {
            content: { role: 'model', parts: [{ text: 'hello' }] },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: {
          promptTokenCount: 120,
          candidatesTokenCount: 40,
          totalTokenCount: 160,
          cachedContentTokenCount: 25,
          thoughtsTokenCount: 15,
          toolUsePromptTokenCount: 8, // no slot — stored internally, not surfaced
        },
      }),
    );
    const r = o.finalize('complete');
    expect(r.usage.input).toEqual({ value: 120, source: 'upstream-reported' });
    expect(r.usage.output).toEqual({ value: 40, source: 'upstream-reported' });
    expect(r.usage.total).toEqual({ value: 160, source: 'upstream-reported' });
    expect(r.usage.cacheRead).toEqual({ value: 25, source: 'upstream-reported' });
    expect(r.usage.thought).toEqual({ value: 15, source: 'upstream-reported' });
    // cacheWrite is always null — Vertex doesn't report it.
    expect(r.usage.cacheWrite).toBeNull();
    // credits is always null — Vertex bills GCP-side, nothing on wire.
    expect((r.usage as Record<string, unknown>).credits).toBeUndefined();
  });

  test('usageMetadata from LAST frame wins (cumulative, each frame overwrites)', () => {
    const o = adapter.createObserver();
    // First frame: partial usage
    o.onFrame(
      frame({
        candidates: [{ content: { role: 'model', parts: [{ text: 'partial' }] } }],
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10, totalTokenCount: 110 },
      }),
    );
    // Last frame: final cumulative usage
    o.onFrame(
      frame({
        candidates: [
          {
            content: { role: 'model', parts: [{ text: ' final' }] },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 35, totalTokenCount: 135 },
      }),
    );
    const r = o.finalize('complete');
    expect(r.usage.output?.value).toBe(35);
    expect(r.usage.total?.value).toBe(135);
  });

  test('clean stream (no sentinel, HTTP end) → stopReason from wire finishReason', () => {
    const o = adapter.createObserver();
    o.onFrame(
      frame({
        candidates: [
          {
            content: { role: 'model', parts: [{ text: 'done' }] },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
      }),
    );
    // No terminal sentinel frame — HTTP stream just ends.
    const r = o.finalize('complete');
    expect(r.stopReason).toBe('STOP');
  });

  test('truncated stream (client_aborted) → stopReason is client_aborted', () => {
    const o = adapter.createObserver();
    o.onFrame(
      frame({
        candidates: [{ content: { role: 'model', parts: [{ text: 'partial' }] } }],
        // No finishReason — stream was cut.
      }),
    );
    const r = o.finalize('client_aborted');
    expect(r.stopReason).toBe('client_aborted');
  });

  test('clean stream with no finishReason on wire → stopReason is null', () => {
    // Valid scenario: Gemini can end the stream without an explicit finishReason
    // in some edge cases.  Clean HTTP end should not be labelled as aborted.
    const o = adapter.createObserver();
    o.onFrame(
      frame({
        candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] } }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 },
      }),
    );
    const r = o.finalize('complete');
    expect(r.stopReason).toBeNull();
  });

  test('sawFirstContent() is false before any content frame', () => {
    const o = adapter.createObserver();
    expect(o.sawFirstContent()).toBe(false);
    o.onFrame(
      frame({
        usageMetadata: { promptTokenCount: 10 },
        // candidates absent — metadata-only frame
      }),
    );
    expect(o.sawFirstContent()).toBe(false);
  });

  test('sawFirstContent() becomes true after a text part arrives', () => {
    const o = adapter.createObserver();
    o.onFrame(
      frame({
        candidates: [{ content: { role: 'model', parts: [{ text: 'hi' }] } }],
      }),
    );
    expect(o.sawFirstContent()).toBe(true);
  });

  test('thought parts accumulate into thinking block in finalized message', () => {
    const o = adapter.createObserver();
    o.onFrame(
      frame({
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                { text: 'let me think', thought: true, thoughtSignature: 'sig-abc' },
                { text: 'my answer' },
              ],
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 8, totalTokenCount: 28 },
      }),
    );
    const r = o.finalize('complete');
    const blocks = r.message?.blocks ?? [];
    expect(blocks[0]?.type).toBe('thinking');
    if (blocks[0]?.type === 'thinking') {
      expect(blocks[0].thinking).toBe('let me think');
      expect(blocks[0].signature).toBe('sig-abc');
    }
    expect(blocks[1]?.type).toBe('text');
    if (blocks[1]?.type === 'text') {
      expect(blocks[1].text).toBe('my answer');
    }
    // thoughtsTokenCount not in this fixture → null
    expect(r.usage.thought ?? null).toBeNull();
  });

  test('multi-frame streaming accumulates text across frames', () => {
    const o = adapter.createObserver();
    for (const chunk of ['Hello, ', 'how ', 'are ', 'you?']) {
      o.onFrame(
        frame({
          candidates: [{ content: { role: 'model', parts: [{ text: chunk }] } }],
        }),
      );
    }
    o.onFrame(
      frame({
        candidates: [
          {
            content: { role: 'model', parts: [] },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 8, totalTokenCount: 13 },
      }),
    );
    const r = o.finalize('complete');
    const textBlock = r.message?.blocks[0];
    expect(textBlock?.type).toBe('text');
    if (textBlock?.type === 'text') {
      expect(textBlock.text).toBe('Hello, how are you?');
    }
  });

  test('functionCall in model response → tool_use block and toolUses entry', () => {
    const o = adapter.createObserver();
    o.onFrame(
      frame({
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{ functionCall: { name: 'bash', args: { cmd: 'ls -la' } } }],
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 12, totalTokenCount: 42 },
      }),
    );
    const r = o.finalize('complete');
    const blocks = r.message?.blocks ?? [];
    expect(blocks[0]?.type).toBe('tool_use');
    if (blocks[0]?.type === 'tool_use') {
      expect(blocks[0].name).toBe('bash');
      expect(blocks[0].input).toEqual({ cmd: 'ls -la' });
    }
    expect(r.toolUses).toHaveLength(1);
    expect(r.toolUses[0]?.name).toBe('bash');
    expect(r.toolUses[0]?.inputJson).toBe('{"cmd":"ls -la"}');
  });

  test('null message when no content arrives', () => {
    const o = adapter.createObserver();
    o.onFrame(
      frame({
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 0, totalTokenCount: 5 },
        candidates: [{ finishReason: 'STOP' }],
      }),
    );
    const r = o.finalize('complete');
    expect(r.message).toBeNull();
  });

  test('frameStats counts frames and bytes correctly', () => {
    const o = adapter.createObserver();
    const f1 = frame({ candidates: [{ content: { role: 'model', parts: [{ text: 'hi' }] } }] });
    const f2 = frame({
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 },
    });
    o.onFrame(f1);
    o.onFrame(f2);
    const r = o.finalize('complete');
    expect(r.frameStats.frames).toBe(2);
    expect(r.frameStats.bytes).toBe(f1.data.length + f2.data.length);
    expect(r.frameStats.parseErrors).toBe(0);
  });

  test('non-streaming onCompleteBody normalizes the same way as frames', () => {
    const o = adapter.createObserver();
    o.onCompleteBody({
      candidates: [
        {
          content: { role: 'model', parts: [{ text: 'complete answer' }] },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4, totalTokenCount: 14 },
    });
    const r = o.finalize('complete');
    expect(r.usage.input?.value).toBe(10);
    expect(r.usage.output?.value).toBe(4);
    expect(r.message?.blocks[0]?.type).toBe('text');
    if (r.message?.blocks[0]?.type === 'text') {
      expect(r.message.blocks[0].text).toBe('complete answer');
    }
    expect(r.stopReason).toBe('STOP');
  });
});
