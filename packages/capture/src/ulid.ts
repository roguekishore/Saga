/**
 * Monotonic ULID: 48-bit ms timestamp + 80-bit randomness, Crockford base32.
 * Sortable request ids make `ORDER BY request_id` and `ORDER BY ts` agree.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

let lastTime = 0;
let lastRandom: number[] = [];

function encodeTime(ms: number): string {
  let out = '';
  let t = ms;
  for (let i = 0; i < 10; i++) {
    out = ALPHABET[t % 32] + out;
    t = Math.floor(t / 32);
  }
  return out;
}

function randomPart(): number[] {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  // 16 base32 chars from 80 bits: take 5 bits per char from 10 bytes.
  const chars: number[] = [];
  let bitBuf = 0;
  let bitLen = 0;
  for (let i = 0; i < 10; i++) {
    bitBuf = (bitBuf << 8) | bytes[i]!;
    bitLen += 8;
    while (bitLen >= 5) {
      bitLen -= 5;
      chars.push((bitBuf >> bitLen) & 31);
    }
  }
  return chars;
}

export function ulid(now: number = Date.now()): string {
  if (now === lastTime) {
    // Increment the random part so same-ms ids stay ordered.
    for (let i = lastRandom.length - 1; i >= 0; i--) {
      if (lastRandom[i]! < 31) {
        lastRandom[i]!++;
        break;
      }
      lastRandom[i] = 0;
    }
  } else {
    lastTime = now;
    lastRandom = randomPart();
  }
  return encodeTime(now) + lastRandom.map((c) => ALPHABET[c]).join('');
}
