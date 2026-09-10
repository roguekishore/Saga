import { describe, expect, test } from 'bun:test';
import type { SseFrame } from '@saga/contracts';
import { openaiAdapter } from '../src/openai';
import { passthroughAdapter } from '../src/passthrough';

const adapter = openaiAdapter({ usageSource: 'gateway-computed' });

function frame(json: Record<string, unknown> | string): SseFrame {
  if (typeof json === 'string') return { event: null, data: json, json: null };
  return { event: null, data: JSON.stringify(json), json };
}

const ctx = (body: unknown) => ({
  method: 'POST',
  path: '/v1/chat/completions',
  headers: {},
  body,
});

describe('openai normalizeRequest', () => {
  test('system/developer split out; tool role becomes tool_result; tool_calls become tool_use', () => {
    const r = adapter.normalizeRequest(
      ctx({
        model: 'gpt-4o',
        stream: true,
        messages: [
          { role: 'system', content: 'be helpful' },
          { role: 'user', content: 'run ls' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'bash', arguments: '{"cmd":"ls"}' },
              },
            ],
          },
          { role: 'tool', tool_call_id: 'call_1', content: 'file-a' },
        ],
        tools: [
          { type: 'function', function: { name: 'bash', description: 'shell', parameters: {} } },
        ],
      }),
    );
    expect(r.system.length).toBe(1);
    expect(r.messages.length).toBe(3);
    expect(r.messages[0]?.contextSource).toBe('history');
    const tu = r.messages[1]?.blocks.find((b) => b.type === 'tool_use');
    expect(tu && tu.type === 'tool_use' && tu.name).toBe('bash');
    const tr = r.messages[2]?.blocks[0];
    expect(tr?.type).toBe('tool_result');
    if (tr?.type === 'tool_result') expect(tr.toolUseId).toBe('call_1');
    expect(r.messages[2]?.contextSource).toBe('tool');
    expect(r.tools[0]?.name).toBe('bash');
  });
});

describe('openai stream observer', () => {
  test('content + reasoning + split tool args + usage on final chunk + [DONE]', () => {
    const o = adapter.createObserver();
    o.onFrame(frame({ choices: [{ index: 0, delta: { role: 'assistant' } }] }));
    expect(o.sawFirstContent()).toBe(false);
    o.onFrame(frame({ choices: [{ index: 0, delta: { reasoning_content: 'thinking…' } }] }));
    expect(o.sawFirstContent()).toBe(true);
    o.onFrame(frame({ choices: [{ index: 0, delta: { content: 'Sure — ' } }] }));
    o.onFrame(frame({ choices: [{ index: 0, delta: { content: 'done.' } }] }));
    o.onFrame(
      frame({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: 'call_9', function: { name: 'search', arguments: '{"q":' } },
              ],
            },
          },
        ],
      }),
    );
    o.onFrame(
      frame({
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"saga"}' } }] } },
        ],
      }),
    );
    o.onFrame(frame({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }));
    o.onFrame(frame({ choices: [], usage: { prompt_tokens: 900, completion_tokens: 33 } }));
    o.onFrame(frame('[DONE]'));

    const r = o.finalize('complete');
    expect(r.usage.input).toEqual({ value: 900, source: 'gateway-computed' });
    expect(r.usage.output).toEqual({ value: 33, source: 'gateway-computed' });
    expect(r.stopReason).toBe('tool_calls');
    expect(r.message?.blocks.map((b) => b.type)).toEqual(['thinking', 'text', 'tool_use']);
    const tool = r.message?.blocks[2];
    if (tool?.type === 'tool_use') expect(tool.input).toEqual({ q: 'saga' });
    expect(r.frameStats.parseErrors).toBe(0);
  });

  test('cached prompt tokens map to cacheRead when reported', () => {
    const o = adapter.createObserver();
    o.onCompleteBody({
      choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 2,
        prompt_tokens_details: { cached_tokens: 64 },
      },
    });
    const r = o.finalize('complete');
    expect(r.usage.cacheRead).toEqual({ value: 64, source: 'gateway-computed' });
  });
});

describe('passthrough', () => {
  test('matches anything and stores only redactable raw', () => {
    const p = passthroughAdapter();
    expect(p.matches({ method: 'GET', path: '/v1/models', headers: {}, body: null })).toBe(true);
    const r = p.normalizeRequest({ method: 'GET', path: '/v1/models', headers: {}, body: null });
    expect(r.messages).toEqual([]);
    expect(r.rawRequestJson).toBe('null');
    const o = p.createObserver();
    o.onFrame({ event: null, data: 'x'.repeat(10), json: null });
    const res = o.finalize('complete');
    expect(res.frameStats.frames).toBe(1);
    expect(res.usage.input).toBeNull();
  });
});
