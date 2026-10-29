/**
 * One-shot debug script: decode message by id from saga.db and print block summary.
 * Usage: bun tools/decode-msg.ts <message_id>
 */
import { Database } from 'bun:sqlite';
import { brotliDecompressSync } from 'node:zlib';
import { resolve } from 'node:path';

const id = Number(process.argv[2] ?? 2190);
const dbPath = resolve(import.meta.dir, '../storage/saga.db');

const db = new Database(dbPath, { readonly: true });
const row = db.prepare('SELECT body, compressed FROM messages WHERE id = ?').get(id) as {
  body: Uint8Array;
  compressed: number;
} | null;

if (!row) {
  console.error(`No message with id=${id}`);
  process.exit(1);
}

const raw = row.compressed ? brotliDecompressSync(row.body) : row.body;
const text = raw.toString('utf-8');

// The body is a JSON-encoded Anthropic request body.
// Unwrap double-encoding if present (saga captures may double-encode).
let parsed: unknown;
try {
  const outer = JSON.parse(text);
  // Check if it's double-encoded (string inside)
  if (typeof outer === 'string') {
    parsed = JSON.parse(outer);
  } else {
    parsed = outer;
  }
} catch (e) {
  console.error('Failed to parse JSON:', e);
  console.log('Raw text (first 500 chars):', text.slice(0, 500));
  process.exit(1);
}

const body = parsed as {
  messages?: Array<{ role: string; content: unknown }>;
  system?: unknown;
};

const top = body as Record<string, unknown>;
console.log('Top-level keys:', Object.keys(top));

// SAGA normalized message format: { role, blocks[] } or Anthropic { messages[] }
if (Array.isArray(top.blocks)) {
  // Single normalized message
  const blocks = top.blocks as Array<{ type: string; text?: string }>;
  console.log(`\nSingle message role=${top.role}, ${blocks.length} blocks\n`);
  for (let j = 0; j < blocks.length; j++) {
    const block = blocks[j];
    if (block.type === 'text') {
      const t = block.text ?? '';
      const trimmed = t.trimStart();
      console.log(`block[${j}] type=text len=${t.length}`);
      console.log(`  first 300: ${trimmed.slice(0, 300).replace(/\n/g, '↵')}`);
    } else {
      console.log(`block[${j}] type=${block.type}`);
    }
    console.log();
  }
} else if (Array.isArray(top.messages)) {
  const msgs = top.messages as Array<{ role: string; content: unknown }>;
  console.log(`\n${msgs.length} messages in body\n`);
  for (let i = 0; i < msgs.length; i++) {
    const msg = msgs[i];
    console.log(`--- messages[${i}] role=${msg.role} ---`);
    const content = msg.content;
    if (typeof content === 'string') {
      console.log(`  [string content] len=${content.length}`);
      console.log(`  preview: ${content.slice(0, 200)}`);
    } else if (Array.isArray(content)) {
      console.log(`  [${content.length} blocks]`);
      for (let j = 0; j < content.length; j++) {
        const block = content[j] as { type: string; text?: string };
        if (block.type === 'text') {
          const t = block.text ?? '';
          const trimmed = t.trimStart();
          console.log(`  block[${j}] type=text len=${t.length}`);
          console.log(`    first 300: ${trimmed.slice(0, 300).replace(/\n/g, '↵')}`);
        } else {
          console.log(`  block[${j}] type=${block.type}`);
        }
      }
    }
    console.log();
  }
} else {
  console.log('Unknown format. Keys:', Object.keys(top));
  console.log(JSON.stringify(top).slice(0, 500));
}
