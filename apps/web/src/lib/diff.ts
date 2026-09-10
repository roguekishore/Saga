/**
 * Line diff via LCS with common prefix/suffix trimming. Dependency-free on
 * purpose: Monaco's diff editor costs megabytes and a worker pipeline; a
 * prompt diff needs added/removed/context lines, not a language service.
 * Guarded to keep the DP quadratic core small.
 */

export type DiffLine =
  | { kind: 'same'; a: number; b: number; text: string }
  | { kind: 'del'; a: number; text: string }
  | { kind: 'add'; b: number; text: string };

const MAX_DP_LINES = 2400;

export function diffLines(aText: string, bText: string): { lines: DiffLine[]; truncated: boolean } {
  const a = aText.split('\n');
  const b = bText.split('\n');

  // trim common prefix/suffix
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const lines: DiffLine[] = [];

  for (let i = 0; i < start; i++) lines.push({ kind: 'same', a: i + 1, b: i + 1, text: a[i]! });

  let truncated = false;
  if (midA.length + midB.length > MAX_DP_LINES * 2) {
    // Too large for the DP core: fall back to plain replace semantics.
    truncated = true;
    midA.forEach((t, i) => {
      lines.push({ kind: 'del', a: start + i + 1, text: t });
    });
    midB.forEach((t, i) => {
      lines.push({ kind: 'add', b: start + i + 1, text: t });
    });
  } else {
    // LCS table
    const n = midA.length;
    const m = midB.length;
    const dp = new Uint16Array((n + 1) * (m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * (m + 1) + j] =
          midA[i] === midB[j]
            ? dp[(i + 1) * (m + 1) + j + 1]! + 1
            : Math.max(dp[(i + 1) * (m + 1) + j]!, dp[i * (m + 1) + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        lines.push({ kind: 'same', a: start + i + 1, b: start + j + 1, text: midA[i]! });
        i++;
        j++;
      } else if (dp[(i + 1) * (m + 1) + j]! >= dp[i * (m + 1) + j + 1]!) {
        lines.push({ kind: 'del', a: start + i + 1, text: midA[i]! });
        i++;
      } else {
        lines.push({ kind: 'add', b: start + j + 1, text: midB[j]! });
        j++;
      }
    }
    while (i < n) {
      lines.push({ kind: 'del', a: start + i + 1, text: midA[i]! });
      i++;
    }
    while (j < m) {
      lines.push({ kind: 'add', b: start + j + 1, text: midB[j]! });
      j++;
    }
  }

  for (let k = 0; k < a.length - endA; k++) {
    lines.push({
      kind: 'same',
      a: endA + k + 1,
      b: endB + k + 1,
      text: a[endA + k]!,
    });
  }

  return { lines, truncated };
}

export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.kind === 'add') added++;
    else if (l.kind === 'del') removed++;
  }
  return { added, removed };
}
