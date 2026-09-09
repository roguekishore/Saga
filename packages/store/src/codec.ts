import { brotliCompressSync, brotliDecompressSync, constants } from 'node:zlib';

/**
 * Body codec: canonical JSON in, `{ body, compressed }` out. Bodies under the
 * threshold aren't worth the CPU; larger ones get Brotli at quality 5 —
 * measured on the fixture corpus rather than assumed (the 4% ground-truth
 * ratio came from pathologically repetitive input).
 */
export const COMPRESS_THRESHOLD = 512;
const QUALITY = 5;

export function encodeBody(text: string): {
  body: Uint8Array;
  compressed: boolean;
  rawBytes: number;
} {
  const raw = Buffer.from(text, 'utf-8');
  if (raw.byteLength < COMPRESS_THRESHOLD) {
    return { body: new Uint8Array(raw), compressed: false, rawBytes: raw.byteLength };
  }
  const packed = brotliCompressSync(raw, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: QUALITY,
      [constants.BROTLI_PARAM_SIZE_HINT]: raw.byteLength,
    },
  });
  // Incompressible input: keep the raw bytes, honesty over ceremony.
  if (packed.byteLength >= raw.byteLength) {
    return { body: new Uint8Array(raw), compressed: false, rawBytes: raw.byteLength };
  }
  return { body: new Uint8Array(packed), compressed: true, rawBytes: raw.byteLength };
}

export function decodeBody(body: Uint8Array, compressed: boolean): string {
  if (!compressed) return Buffer.from(body).toString('utf-8');
  return brotliDecompressSync(body).toString('utf-8');
}

export function sha256hex(text: string): string {
  const h = new Bun.CryptoHasher('sha256');
  h.update(text);
  return h.digest('hex');
}
