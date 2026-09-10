import type { BlockContextKind, Provenance } from '@saga/contracts';

/**
 * The honesty color system — the one part of the design that is not an
 * aesthetic choice. Every token/cost figure renders with its source; every
 * heuristic renders as inferred; absent data renders n/a with the reason.
 */
export const PROVENANCE_META: Record<
  Provenance,
  { label: string; short: string; tone: 'upstream' | 'gateway' | 'saga'; explain: string }
> = {
  'upstream-reported': {
    label: 'upstream-reported',
    short: 'upstream',
    tone: 'upstream',
    explain: 'The provider itself returned this number.',
  },
  'gateway-computed': {
    label: 'gateway-computed',
    short: 'gateway',
    tone: 'gateway',
    explain:
      'Computed by a gateway in the middle, not the provider. On kiro-gateway this is tiktoken cl100k_base × ~1.15 — an estimate wearing a usage field.',
  },
  'saga-estimated': {
    label: 'SAGA-estimated',
    short: 'estimated',
    tone: 'saga',
    explain: 'Derived by SAGA (chars/4 class heuristic). The weakest provenance — treat as a hint.',
  },
};

export function describeSources(sources: Provenance[]): {
  short: string;
  tone: 'upstream' | 'gateway' | 'saga' | 'mixed' | 'none';
  explain: string;
} {
  const uniq = [...new Set(sources)];
  if (uniq.length === 0) {
    return { short: 'no data', tone: 'none', explain: 'No source produced this number.' };
  }
  if (uniq.length === 1) {
    const m = PROVENANCE_META[uniq[0]!];
    return { short: m.short, tone: m.tone, explain: m.explain };
  }
  return {
    short: 'mixed',
    tone: 'mixed',
    explain: `Aggregated from mixed sources: ${uniq.join(', ')}.`,
  };
}

export const INFERRED_EXPLAIN: Record<string, string> = {
  session:
    'This client stated no session id, so SAGA guessed the boundary: client + workspace (or system-prompt fingerprint), split on 30 min idle.',
  workspace:
    'Sniffed from system-prompt text. The client never sends a structured workspace field.',
  agent:
    'Agent parent/child relationships are correlated from request shape and timing. They are a guess, never wire truth.',
  memory:
    'Memory attribution is decided inside the client before the request; SAGA infers it from position and markers.',
  'tool-round-trip':
    'Round-trip is the wall time between a tool_use going out and the next request carrying its result — inferred, includes client think time.',
};

/**
 * Facts the CLIENT states on the wire. The counterpart to
 * `INFERRED_EXPLAIN` — same surface, opposite claim — so a reader can tell at a
 * glance which rows are evidence and which are SAGA's guesswork. Rendered with
 * a solid border where inferred facts get a dashed one.
 */
export const WIRE_EXPLAIN: Record<string, string> = {
  session:
    'The client stated this session id on the wire (Claude Code sends it on every request). This boundary is evidence, not a SAGA guess.',
  title:
    "Read from the client's own local transcript — the name Claude Code gave this conversation. Not from the wire, and not inferred.",
  cwd: 'The working directory the client recorded for this session, read from its own local transcript rather than sniffed from prompt text.',
};

/**
 * How to talk about a message's `firstObservedAt`. Measured, not inferred --
 * but it dates the first SIGHTING of that exact body, which is not the same
 * claim as "sent at", so it never renders as a bare clock.
 *
 * The one genuinely derived bit is `carriedOver`: a stamp predating the
 * request's own `ts` proves the body was already in the context before this
 * turn went out. That is wire evidence, not a guess.
 */
export function describeMessageTime(
  firstObservedAt: number | null | undefined,
  requestTs: number | null | undefined,
): { carriedOver: boolean; explain: string } | null {
  if (firstObservedAt == null) return null;
  const carriedOver = requestTs != null && firstObservedAt < requestTs;
  const base =
    'First observed on the wire at this time. SAGA stores one row per unique message body and dedup never overwrites that first sighting, so byte-identical repeats collapse onto their earliest occurrence — read this as first-observed, not sent-at.';
  return {
    carriedOver,
    explain: carriedOver
      ? `${base} It predates this request, so this body was already in the context before this turn was sent: carried-over history, not new input.`
      : base,
  };
}

/**
 * How each per-block label is presented. The distinction this table exists to
 * make: `you` is the only tone credited to the human, and it is the one label
 * that rests on absence of evidence rather than presence of it -- so its
 * explanation says so out loud.
 */
export const BLOCK_CONTEXT_META: Record<
  BlockContextKind,
  { label: string; tone: 'you' | 'injected' | 'structural'; explain: string }
> = {
  'user-prose': {
    label: 'your input',
    tone: 'you',
    explain:
      "Unmarked prose in a user-role block -- SAGA's best guess at what you actually typed. This is a guess by ABSENCE: the client sends your words and its own injected context in the same role, so anything carrying no known marker lands here. An injection SAGA does not recognize yet would be mislabeled as yours.",
  },
  'system-prompt': {
    label: 'system prompt',
    tone: 'injected',
    explain:
      "Text from the request's top-level `system` field. A declared location on the wire, so this label is read, not inferred. It is the harness identity and rules -- never something you typed into the chat.",
  },
  'system-reminder': {
    label: 'injected context',
    tone: 'injected',
    explain:
      'A <system-reminder> envelope: context the client wrapped around your turn before sending. It arrives in the same user-role message as your text, which is exactly why it needs its own label.',
  },
  memory: {
    label: 'memory / instructions',
    tone: 'injected',
    explain:
      'Recalled memory or project instructions (CLAUDE.md, MEMORY.md) injected by the client. The decision to include this was made before the request; nothing on the wire declares it, so SAGA sniffs it from markers.',
  },
  'command-echo': {
    label: 'command echo',
    tone: 'injected',
    explain:
      'The client echoing a slash command you invoked (<command-name>, <command-message>, <command-args>). You triggered it, but you did not type this text.',
  },
  'command-output': {
    label: 'command output',
    tone: 'injected',
    explain:
      'Captured stdout of a locally-run command, or the caveat wrapper the client puts around it. Machine output, fed into the prompt.',
  },
  harness: {
    label: 'harness',
    tone: 'injected',
    explain:
      'Other client-authored scaffolding: transcript or session envelopes, serialized records, or a block whose shape SAGA does not recognize. Not prose either party wrote in conversation.',
  },
  'tool-result': {
    label: 'tool result',
    tone: 'structural',
    explain:
      'A tool result the client fed back in. It travels as a user-role message because the API has no other channel for it -- structural, not something you wrote.',
  },
  'model-output': {
    label: 'model output',
    tone: 'structural',
    explain: 'Assistant-authored content: response text, extended thinking, or a tool call.',
  },
  'non-text': {
    label: 'no text',
    tone: 'structural',
    explain:
      'Carries no text to classify -- an image (content never stored) or provider-encrypted reasoning.',
  },
};
