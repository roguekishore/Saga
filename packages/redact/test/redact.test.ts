import { describe, expect, test } from 'bun:test';
import { looksLikeSecret, shannonEntropy } from '../src/entropy';
import { redactNormalizedRequest, scrubHeaders, scrubText, scrubValue } from '../src/scrub';

/** Planted fakes — shaped like the real thing, valid nowhere. */
export const PLANTED = {
  anthropic: 'sk-ant-api03-FAKEfakeFAKEfakeFAKE1234567890abcdefghijklmnop',
  openai: 'sk-proj-FAKE2fake2FAKE2fake2FAKE2fake2FAKE2fake2',
  githubPat: 'ghp_FAKEfakeFAKEfakeFAKEfakeFAKEfake1234',
  githubFine: 'github_pat_11FAKEFAKE0abcdefghijklmnopqrstuvwxyz',
  awsAccessKeyId: 'AKIAFAKEFAKE12345678',
  awsSecret: 'FAKEfake1234FAKEfake5678FAKEfake9012FAKE',
  googleKey: 'AIzaFAKEfakeFAKEfakeFAKEfakeFAKEfake123',
  slack: 'xoxb-1234567890-FAKEFAKEFAKEfakefake',
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlLXVzZXIifQ.FAKEsigFAKEsigFAKEsig',
  bearer: 'Bearer FAKEtokenFAKEtokenFAKEtoken123456',
  entropyBlob: 'q7Rt2xKp9mWz4Lc8Vn3Yb6Hd1Fs5Gj0QaZwSxEd',
} as const;

describe('scrubText — every planted secret is absent from output', () => {
  const cases: Array<[string, string]> = [
    ['anthropic-key', `here is a key ${PLANTED.anthropic} in prose`],
    ['openai-key', `OPENAI_API_KEY=${PLANTED.openai}`],
    ['github-pat', `git clone https://${PLANTED.githubPat}@github.com/x/y.git`],
    ['github-fine-pat', `token: ${PLANTED.githubFine}`],
    ['aws-access-key-id', `aws_access_key_id = ${PLANTED.awsAccessKeyId}`],
    ['aws-secret-key', `aws_secret_access_key = "${PLANTED.awsSecret}"`],
    ['google-api-key', `key=${PLANTED.googleKey}`],
    ['slack-token', `SLACK_BOT_TOKEN=${PLANTED.slack}`],
    ['jwt', `session ${PLANTED.jwt} expired`],
    ['bearer-token', `Authorization: ${PLANTED.bearer}`],
  ];

  for (const [kind, text] of cases) {
    test(kind, () => {
      const r = scrubText(text);
      for (const secret of Object.values(PLANTED)) {
        if (text.includes(secret)) expect(r.value).not.toContain(secret);
      }
      expect(r.value).toContain('[REDACTED:');
      expect(r.hits.length).toBeGreaterThan(0);
    });
  }

  test('private key block', () => {
    const pem = `-----BEGIN RSA PRIVATE KEY-----\nMIIFAKEfakeFAKE\nfakeFAKEfake\n-----END RSA PRIVATE KEY-----`;
    const r = scrubText(`config:\n${pem}\ndone`);
    expect(r.value).not.toContain('MIIFAKEfakeFAKE');
    expect(r.value).toContain('[REDACTED:private-key-block:');
  });

  test('same secret twice → same fingerprint (correlation without reveal)', () => {
    const r = scrubText(`a=${PLANTED.anthropic} b=${PLANTED.anthropic}`);
    const fps = [...r.value.matchAll(/\[REDACTED:anthropic-key:([0-9a-f]{6})\]/g)].map((m) => m[1]);
    expect(fps.length).toBe(2);
    expect(fps[0]).toBe(fps[1]);
  });

  test('idempotent: scrubbing scrubbed text changes nothing', () => {
    const once = scrubText(`key ${PLANTED.anthropic} and blob ${PLANTED.entropyBlob}`).value;
    const twice = scrubText(once).value;
    expect(twice).toBe(once);
  });
});

describe('fail-closed entropy backstop', () => {
  test('unrecognized high-entropy blob is scrubbed AND flagged', () => {
    const r = scrubText(`the service responded with token ${PLANTED.entropyBlob} ok`);
    expect(r.value).not.toContain(PLANTED.entropyBlob);
    expect(r.flagged).toBe(true);
    expect(r.hits.some((h) => h.kind === 'entropy-suspect')).toBe(true);
  });

  test('leaves benign long strings alone', () => {
    const benign = [
      'createStreamObserverFactoryInstance',
      'anthropic_beta_prompt_caching_v2_enabled',
      '3f8a2b9c1d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a', // git sha
      '9150e749-b67e-4ed8-a3b9-4cb3aa881775', // uuid
      'ExtremelyLongCamelCaseIdentifierNameHere',
    ];
    for (const s of benign) {
      expect(looksLikeSecret(s)).toBe(false);
      const r = scrubText(`code mentions ${s} here`);
      expect(r.value).toContain(s);
      expect(r.flagged).toBe(false);
    }
  });

  test('entropy math sanity', () => {
    expect(shannonEntropy('aaaa')).toBe(0);
    expect(shannonEntropy('abcd')).toBe(2);
  });
});

describe('deep scrubs', () => {
  test('sensitive keys redacted wholesale, nested strings scrubbed', () => {
    const r = scrubValue({
      model: 'claude-sonnet-4',
      api_key: 'plain-looking-value',
      nested: { messages: [{ text: `use ${PLANTED.openai}` }] },
      count: 3,
    });
    const s = JSON.stringify(r.value);
    expect(s).not.toContain('plain-looking-value');
    expect(s).not.toContain(PLANTED.openai);
    expect(s).toContain('claude-sonnet-4');
    expect(r.hits.some((h) => h.kind === 'sensitive-key')).toBe(true);
  });

  test('headers: auth wholesale, others scrubbed, benign kept', () => {
    const r = scrubHeaders({
      Authorization: PLANTED.bearer,
      Cookie: 'sid=FAKEfakeFAKE',
      'User-Agent': 'claude-code/1.2.3',
      'X-Api-Key': PLANTED.anthropic,
    });
    const s = JSON.stringify(r.value);
    expect(s).not.toContain('FAKEtoken');
    expect(s).not.toContain('sid=FAKE');
    expect(s).not.toContain(PLANTED.anthropic);
    expect(r.value['user-agent']).toBe('claude-code/1.2.3');
  });

  test('redactNormalizedRequest scrubs blocks, params, and raw JSON', () => {
    const raw = JSON.stringify({ model: 'm', key: PLANTED.anthropic });
    const r = redactNormalizedRequest({
      model: 'm',
      stream: true,
      system: [
        {
          role: 'system',
          blocks: [{ type: 'text', text: `system says ${PLANTED.githubPat}` }],
          contextSource: 'system',
          contextSourceInferred: false,
        },
      ],
      messages: [
        {
          role: 'user',
          blocks: [
            { type: 'text', text: `hello ${PLANTED.jwt}` },
            {
              type: 'tool_use',
              id: 't1',
              name: 'Bash',
              input: { cmd: `curl -H 'Authorization: ${PLANTED.bearer}'` },
              inputJson: `{"cmd":"curl -H 'Authorization: ${PLANTED.bearer}'"}`,
            },
          ],
          contextSource: 'user',
          contextSourceInferred: false,
        },
      ],
      tools: [],
      paramsJson: JSON.stringify({ temperature: 1 }),
      rawRequestJson: raw,
    });
    const s = JSON.stringify(r.value);
    for (const secret of [PLANTED.githubPat, PLANTED.jwt, PLANTED.anthropic]) {
      expect(s).not.toContain(secret);
    }
    expect(s).not.toContain('FAKEtokenFAKEtoken');
    expect(r.hits.length).toBeGreaterThanOrEqual(3);
  });
});
