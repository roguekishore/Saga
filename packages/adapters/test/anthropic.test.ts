import { describe, expect, test } from 'bun:test';
import type { SseFrame } from '@saga/contracts';
import { anthropicAdapter } from '../src/anthropic';

const adapter = anthropicAdapter({ usageSource: 'gateway-computed' });

function frame(json: Record<string, unknown>): SseFrame {
  const data = JSON.stringify(json);
  return { event: (json.type as string) ?? null, data, json };
}

const ctx = (body: unknown) => ({
  method: 'POST',
  path: '/v1/messages',
  headers: {},
  body,
});

describe('anthropic normalizeRequest', () => {
  test('system string, structural history/user sourcing, tools, image metadata', () => {
    const r = adapter.normalizeRequest(
      ctx({
        model: 'claude-sonnet-4',
        stream: true,
        max_tokens: 512,
        system: 'be terse',
        tools: [{ name: 'Read', description: 'read a file', input_schema: { type: 'object' } }],
        messages: [
          { role: 'user', content: 'first turn' },
          { role: 'assistant', content: [{ type: 'text', text: 'reply' }] },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'now with image' },
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: 'AAAA'.repeat(100) },
              },
            ],
          },
        ],
      }),
    );
    expect(r.model).toBe('claude-sonnet-4');
    expect(r.stream).toBe(true);
    expect(r.system[0]?.blocks[0]).toEqual({ type: 'text', text: 'be terse' });
    expect(r.messages.map((m) => m.contextSource)).toEqual(['history', 'history', 'user']);
    expect(r.messages.every((m) => !m.contextSourceInferred)).toBe(true);
    expect(r.tools[0]?.name).toBe('Read');
    const img = r.messages[2]?.blocks[1];
    expect(img?.type).toBe('image');
    if (img?.type === 'image') {
      expect(img.note).toBe('content-not-stored');
      expect(img.byteSize).toBe(300);
    }
    // The raw request retains the image envelope but SAGA's blocks never carry data.
    expect(JSON.stringify(r.messages[2]?.blocks)).not.toContain('AAAA');
    expect(r.paramsJson).toContain('max_tokens');
    expect(r.paramsJson).not.toContain('first turn');
  });

  test('tool_result-only message is sourced as tool', () => {
    const r = adapter.normalizeRequest(
      ctx({
        model: 'm',
        messages: [
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok', is_error: false }],
          },
        ],
      }),
    );
    expect(r.messages[0]?.contextSource).toBe('tool');
    const b = r.messages[0]?.blocks[0];
    expect(b?.type).toBe('tool_result');
  });

  test('unrecognized block types survive as unknown, not dropped', () => {
    const r = adapter.normalizeRequest(
      ctx({
        model: 'm',
        messages: [{ role: 'user', content: [{ type: 'server_tool_use_2027', payload: 'x' }] }],
      }),
    );
    const b = r.messages[0]?.blocks[0];
    expect(b?.type).toBe('unknown');
    if (b?.type === 'unknown') {
      expect(b.rawType).toBe('server_tool_use_2027');
      expect(b.json).toContain('payload');
    }
  });
});

describe('anthropic stream observer', () => {
  test('thinking + signature + split tool_use json + usage off message_start', () => {
    const o = adapter.createObserver();
    o.onFrame(
      frame({
        type: 'message_start',
        message: {
          id: 'msg_1',
          model: 'claude-sonnet-4',
          usage: { input_tokens: 2048, output_tokens: 1 },
        },
      }),
    );
    expect(o.sawFirstContent()).toBe(false);

    o.onFrame(
      frame({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }),
    );
    o.onFrame(
      frame({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'let me think' },
      }),
    );
    expect(o.sawFirstContent()).toBe(true);
    o.onFrame(
      frame({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: 'c2ln' },
      }),
    );
    o.onFrame(frame({ type: 'content_block_stop', index: 0 }));

    o.onFrame(frame({ type: 'content_block_start', index: 1, content_block: { type: 'text' } }));
    o.onFrame(
      frame({
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'text_delta', text: 'Here: ' },
      }),
    );
    o.onFrame(
      frame({
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'text_delta', text: 'done.' },
      }),
    );
    o.onFrame(frame({ type: 'content_block_stop', index: 1 }));

    o.onFrame(
      frame({
        type: 'content_block_start',
        index: 2,
        content_block: { type: 'tool_use', id: 'toolu_9', name: 'Bash' },
      }),
    );
    o.onFrame(
      frame({
        type: 'content_block_delta',
        index: 2,
        delta: { type: 'input_json_delta', partial_json: '{"cmd":' },
      }),
    );
    o.onFrame(
      frame({
        type: 'content_block_delta',
        index: 2,
        delta: { type: 'input_json_delta', partial_json: '"ls -la"}' },
      }),
    );
    o.onFrame(frame({ type: 'content_block_stop', index: 2 }));

    o.onFrame(
      frame({
        type: 'message_delta',
        delta: { stop_reason: 'tool_use' },
        usage: { output_tokens: 77 },
      }),
    );
    o.onFrame(frame({ type: 'message_stop' }));

    const r = o.finalize('complete');
    expect(r.usage.input).toEqual({ value: 2048, source: 'gateway-computed' });
    expect(r.usage.output).toEqual({ value: 77, source: 'gateway-computed' });
    expect(r.usage.cacheRead).toBeNull(); // nothing produces it on this upstream
    expect(r.stopReason).toBe('tool_use');
    expect(r.message?.blocks.map((b) => b.type)).toEqual(['thinking', 'text', 'tool_use']);
    const think = r.message?.blocks[0];
    if (think?.type === 'thinking') {
      expect(think.thinking).toBe('let me think');
      expect(think.signature).toBe('c2ln');
    }
    const tool = r.message?.blocks[2];
    if (tool?.type === 'tool_use') {
      expect(tool.input).toEqual({ cmd: 'ls -la' });
      expect(tool.inputJson).toBe('{"cmd":"ls -la"}');
    }
    expect(r.toolUses).toEqual([
      { blockIndex: 2, toolUseId: 'toolu_9', name: 'Bash', inputJson: '{"cmd":"ls -la"}' },
    ]);
    expect(r.frameStats.frames).toBe(15);
    expect(r.frameStats.parseErrors).toBe(0);
  });

  test('client abort mid-json keeps the raw partial, input parses to null', () => {
    const o = adapter.createObserver();
    o.onFrame(
      frame({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 't', name: 'Write' },
      }),
    );
    o.onFrame(
      frame({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"path": "/tm' },
      }),
    );
    const r = o.finalize('client_aborted');
    const b = r.message?.blocks[0];
    if (b?.type === 'tool_use') {
      expect(b.input).toBeNull();
      expect(b.inputJson).toBe('{"path": "/tm');
    }
    expect(r.stopReason).toBe('client_aborted');
  });

  test('error frame is exposed', () => {
    const o = adapter.createObserver();
    o.onFrame(frame({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }));
    const r = o.finalize('upstream_error');
    expect(r.message).toBeNull();
    expect((o as unknown as { error: { type: string } }).error.type).toBe('overloaded_error');
  });

  test('non-streaming body normalizes the same way', () => {
    const o = adapter.createObserver();
    o.onCompleteBody({
      type: 'message',
      content: [
        { type: 'text', text: 'plain answer' },
        { type: 'thinking', thinking: 'hidden', signature: 'sig' },
      ],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const r = o.finalize('complete');
    expect(r.message?.blocks.length).toBe(2);
    expect(r.usage.input?.value).toBe(10);
    expect(r.stopReason).toBe('end_turn');
  });
});
