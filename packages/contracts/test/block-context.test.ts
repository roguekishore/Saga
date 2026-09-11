import { describe, expect, test } from 'bun:test';
import { type ContentBlock, classifyBlock, classifyBlocks } from '../src';

/**
 * The classifier's whole job is telling human input apart from client-injected
 * context. Every case below is a shape observed in the live corpus
 * (storage/saga.db, 531 unique messages / 662 blocks, 2026-09-04) — not
 * invented input.
 */

const text = (t: string): ContentBlock => ({ type: 'text', text: t });

describe('block context: structural kinds need no guess', () => {
  test('block type alone decides, and those labels are not inferred', () => {
    expect(
      classifyBlock({ type: 'tool_result', toolUseId: 't1', isError: false, content: [] }, 'user'),
    ).toEqual({
      kind: 'tool-result',
      inferred: false,
      marker: null,
    });
    expect(
      classifyBlock(
        { type: 'tool_use', id: 't1', name: 'Bash', input: null, inputJson: null },
        'assistant',
      ),
    ).toMatchObject({ kind: 'model-output', inferred: false });
    expect(
      classifyBlock({ type: 'thinking', thinking: 'hm', signature: null }, 'assistant'),
    ).toMatchObject({
      kind: 'model-output',
      inferred: false,
    });
    expect(
      classifyBlock(
        { type: 'image', mediaType: 'image/png', byteSize: 10, note: 'content-not-stored' },
        'user',
      ),
    ).toMatchObject({ kind: 'non-text', inferred: false });
  });

  test('an assistant block is model output even when it quotes an injection', () => {
    // Guards against a model echoing harness syntax being read as an injection.
    const c = classifyBlock(text('<system-reminder>as you can see</system-reminder>'), 'assistant');
    expect(c).toEqual({ kind: 'model-output', inferred: false, marker: null });
  });
});

describe('block context: tagged injections', () => {
  test('leading tags are recognized and reported as the deciding marker', () => {
    expect(classifyBlock(text('<system-reminder>\nbe brief\n</system-reminder>'), 'user')).toEqual({
      kind: 'system-reminder',
      inferred: true,
      marker: '<system-reminder>',
    });
    expect(classifyBlock(text('<command-name>/model</command-name>'), 'user')).toMatchObject({
      kind: 'command-echo',
    });
    expect(
      classifyBlock(text('<local-command-stdout>ok</local-command-stdout>'), 'user'),
    ).toMatchObject({
      kind: 'command-output',
    });
    expect(classifyBlock(text('<transcript>abc</transcript>'), 'user')).toMatchObject({
      kind: 'harness',
    });
  });

  test('an injected envelope carrying project instructions reads as memory', () => {
    const c = classifyBlock(
      text(
        '<system-reminder>\n# claudeMd\nCodebase and user instructions are shown below\n</system-reminder>',
      ),
      'user',
    );
    expect(c.kind).toBe('memory');
    expect(c.marker).toContain('<system-reminder>');
  });

  test('leading whitespace does not hide a tag', () => {
    expect(classifyBlock(text('\n\n  <system-reminder>x</system-reminder>'), 'user').kind).toBe(
      'system-reminder',
    );
  });
});

describe('block context: the system field', () => {
  test('system text is a declared wire location, so it is not inferred', () => {
    expect(classifyBlock(text("You are Claude Code, Anthropic's official CLI."), 'system')).toEqual(
      {
        kind: 'system-prompt',
        inferred: false,
        marker: null,
      },
    );
  });

  test('a system block mentioning CLAUDE.md mid-text is memory, never user prose', () => {
    // The real corpus system block: 6.6 KB that mentions CLAUDE.md and
    // <system-reminder> without LEADING with either. Falling through to the
    // prose fallback here would credit the human with the harness identity.
    const c = classifyBlock(
      text('You are an interactive agent.\n...\nContents of CLAUDE.md (project instructions)'),
      'system',
    );
    expect(c.kind).toBe('memory');
    expect(c.inferred).toBe(true);
  });
});

describe('block context: untagged injections', () => {
  test('known untagged harness text is caught despite carrying no marker', () => {
    // Measured: an 8.7 KB block, plainly harness-authored, with no tag at all.
    expect(
      classifyBlock(text('Available agent types for the Agent tool:\n- claude: ...'), 'user').kind,
    ).toBe('harness');
    expect(
      classifyBlock(
        text('Note: D:\\x.ts changed on disk since you last read it. Take it as...'),
        'user',
      ).kind,
    ).toBe('harness');
    expect(
      classifyBlock(text("The following is the user's CLAUDE.md configuration."), 'user').kind,
    ).toBe('memory');
  });

  test('a needle deep inside a long block does NOT trigger — that is quoting', () => {
    const quoted = `${'human writing. '.repeat(60)}Available agent types for the Agent tool:`;
    expect(classifyBlock(text(quoted), 'user').kind).toBe('user-prose');
  });
});

describe('block context: serialized records', () => {
  test('parseable role-keyed and tool-keyed objects are structured data', () => {
    expect(classifyBlock(text('{"user":"hello there"}'), 'user').kind).toBe('harness');
    expect(classifyBlock(text('{"Bash":"cat file.ts"}'), 'user').kind).toBe('harness');
  });

  test('a TRUNCATED dump still reads as a record', () => {
    // The corpus's largest false positive: 21 KB of `{"user":"..."` cut
    // mid-string. Invalid JSON, unmistakably machine-written.
    const truncated = `{"user":"<command-name>/model</command-name>${'x'.repeat(500)}`;
    const c = classifyBlock(text(truncated), 'user');
    expect(c.kind).toBe('harness');
    expect(c.marker).toBe('serialized record (unparseable)');
  });

  test('prose and JSON-ish arrays are not mistaken for records', () => {
    expect(classifyBlock(text('{ not really json'), 'user').kind).toBe('user-prose');
    expect(classifyBlock(text('["a","b"]'), 'user').kind).toBe('user-prose');
  });
});

describe('block context: the prose fallback is always a guess', () => {
  test('unmarked user text is user-prose, and ALWAYS inferred', () => {
    const c = classifyBlock(text('add pagination to the users endpoint'), 'user');
    expect(c).toEqual({ kind: 'user-prose', inferred: true, marker: null });
  });

  test('classifyBlocks stays positionally parallel to its input', () => {
    // The real nine-block turn shape: injections wrapped around one typed line.
    const blocks = [
      text('<system-reminder>\n# claudeMd\nCLAUDE.md\n</system-reminder>'),
      text('<local-command-caveat>caveat</local-command-caveat>'),
      text('<command-name>/model</command-name>'),
      text('<local-command-stdout>set</local-command-stdout>'),
      text('what did I actually type'),
    ];
    const got = classifyBlocks(blocks, 'user');
    expect(got.length).toBe(blocks.length);
    expect(got.map((c) => c.kind)).toEqual([
      'memory',
      'command-output',
      'command-echo',
      'command-output',
      'user-prose',
    ]);
    // Exactly one block in that turn is credited to the human.
    expect(got.filter((c) => c.kind === 'user-prose').length).toBe(1);
  });

  test('empty text is prose-shaped, not a crash', () => {
    expect(classifyBlocks([text('')], 'user')[0]?.kind).toBe('user-prose');
  });
});
