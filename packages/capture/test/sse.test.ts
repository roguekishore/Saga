import { describe, expect, test } from 'bun:test';
import { SseParser } from '../src/sse';

const RECORD_A = 'event: message_start\ndata: {"type":"message_start","n":1}\n\n';
const RECORD_B = 'data: {"type":"content_block_delta","text":"hi"}\n\n';

describe('SseParser tail buffering', () => {
  test('whole records parse', () => {
    const p = new SseParser();
    const frames = p.push(RECORD_A + RECORD_B);
    expect(frames.length).toBe(2);
    expect(frames[0]!.event).toBe('message_start');
    expect((frames[0]!.json as { n: number }).n).toBe(1);
    expect(frames[1]!.event).toBeNull();
  });

  test('a frame split at EVERY byte boundary still parses exactly once', () => {
    const whole = RECORD_A + RECORD_B;
    for (let cut = 1; cut < whole.length - 1; cut++) {
      const p = new SseParser();
      const frames = [...p.push(whole.slice(0, cut)), ...p.push(whole.slice(cut)), ...p.flush()];
      expect(frames.length).toBe(2);
      expect((frames[0]!.json as { n: number }).n).toBe(1);
    }
  });

  test('CRLF records and mixed line endings', () => {
    const p = new SseParser();
    const frames = p.push('event: ping\r\ndata: {"type":"ping"}\r\n\r\ndata: {"x":2}\n\n');
    expect(frames.length).toBe(2);
    expect(frames[0]!.event).toBe('ping');
    expect((frames[1]!.json as { x: number }).x).toBe(2);
  });

  test('multi-line data joins with newline', () => {
    const p = new SseParser();
    const frames = p.push('data: line-one\ndata: line-two\n\n');
    expect(frames[0]!.data).toBe('line-one\nline-two');
    expect(frames[0]!.json).toBeNull();
  });

  test('comments and [DONE] handled; incomplete tail preserved then flushed', () => {
    const p = new SseParser();
    let frames = p.push(': keepalive\n\ndata: [DONE]\n\ndata: {"tail"');
    expect(frames.length).toBe(1);
    expect(frames[0]!.data).toBe('[DONE]');
    expect(p.pendingBytes).toBeGreaterThan(0);
    frames = p.push(':true}\n');
    expect(frames.length).toBe(0);
    const flushed = p.flush();
    expect(flushed.length).toBe(1);
    expect((flushed[0]!.json as { tail: boolean }).tail).toBe(true);
  });
});
