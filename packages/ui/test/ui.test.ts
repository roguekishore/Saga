import { describe, expect, test } from 'bun:test';
import {
  fmtBytes,
  fmtClockMs,
  fmtMs,
  fmtTimeOrDate,
  fmtTokens,
  shortId,
  timeAgo,
} from '../src/format';
import { describeMessageTime, describeSources, PROVENANCE_META } from '../src/provenance-meta';

describe('formatters', () => {
  test('fmtTokens scales sensibly', () => {
    expect(fmtTokens(0)).toBe('0');
    expect(fmtTokens(999)).toBe('999');
    expect(fmtTokens(1500)).toBe('1.5k');
    expect(fmtTokens(45_000)).toBe('45k');
    expect(fmtTokens(2_400_000)).toBe('2.4M');
  });

  test('fmtMs covers sub-ms to minutes', () => {
    expect(fmtMs(null)).toBe('–');
    expect(fmtMs(0.4)).toBe('<1ms');
    expect(fmtMs(230)).toBe('230ms');
    expect(fmtMs(2340)).toBe('2.34s');
    expect(fmtMs(75_000)).toBe('1m 15s');
  });

  test('fmtBytes and shortId and timeAgo', () => {
    expect(fmtBytes(512)).toBe('512 B');
    expect(fmtBytes(2048)).toBe('2.0 KB');
    expect(shortId('req_01K9GXVAHM3F2Y8Q7W6E5R4T2B')).toContain('req_…');
    expect(timeAgo(Date.now() - 90_000)).toBe('1m ago');
  });
});

describe('provenance meta (the honesty contract)', () => {
  test('every provenance has an explanation', () => {
    for (const meta of Object.values(PROVENANCE_META)) {
      expect(meta.explain.length).toBeGreaterThan(20);
    }
  });

  test('describeSources: single, mixed, none', () => {
    expect(describeSources(['gateway-computed']).short).toBe('gateway');
    expect(describeSources(['gateway-computed', 'saga-estimated']).tone).toBe('mixed');
    const none = describeSources([]);
    expect(none.tone).toBe('none');
    expect(none.short).toBe('no data');
  });
});

describe('message clocks', () => {
  test('fmtClockMs keeps milliseconds; timeline ticks differ by ms', () => {
    const t = new Date(2026, 8, 4, 13, 5, 7, 42).getTime();
    expect(fmtClockMs(t)).toBe('13:05:07.042');
  });

  test('fmtTimeOrDate widens to a date once the day differs', () => {
    const ref = new Date(2026, 8, 4, 13, 0, 0).getTime();
    const sameDay = new Date(2026, 8, 4, 9, 30, 15).getTime();
    const weekAgo = new Date(2026, 7, 28, 9, 30, 15).getTime();
    expect(fmtTimeOrDate(sameDay, ref)).toBe('09:30:15');
    // A bare clock here would read as "just sent" on week-old history.
    expect(fmtTimeOrDate(weekAgo, ref)).toBe('2026-08-28 09:30:15');
  });

  test('describeMessageTime never claims sent-at, and flags carried-over bodies', () => {
    expect(describeMessageTime(null, 1000)).toBeNull();
    expect(describeMessageTime(undefined, 1000)).toBeNull();

    const fresh = describeMessageTime(5000, 5000);
    expect(fresh?.carriedOver).toBe(false);
    expect(fresh?.explain).toContain('first-observed, not sent-at');

    const carried = describeMessageTime(4000, 5000);
    expect(carried?.carriedOver).toBe(true);
    expect(carried?.explain).toContain('already in the context');

    // No request ts to compare against: report the sighting, claim nothing.
    expect(describeMessageTime(4000, null)?.carriedOver).toBe(false);
  });
});
