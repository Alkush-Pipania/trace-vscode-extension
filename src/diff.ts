export interface DiffChunk {
  added?: boolean;
  removed?: boolean;
  count: number;
  lines: string[];
}

/**
 * Computes a line-by-line diff using a standard dynamic programming LCS approach.
 * Designed to be highly robust and ignore whitespace discrepancies.
 */
export function diffLines(oldLines: string[], newLines: string[]): DiffChunk[] {
  const n = oldLines.length;
  const m = newLines.length;

  // Fallback to prevent OOM on absurdly massive non-shrunk blocks (~100MB matrix limit)
  if (n * m > 25000000) {
    return [
      { removed: true, count: n, lines: oldLines },
      { added: true, count: m, lines: newLines }
    ];
  }

  // Pre-trim lines for stable comparison
  const tOld = oldLines.map(l => l.trim());
  const tNew = newLines.map(l => l.trim());

  // Memory optimization: instead of allocating n*m up front natively, use a flat 1D array slice 
  // or a Uint32Array for the DP table if needed. For simplicity, we use standard nested arrays.
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Int32Array(m + 1) as any);

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (tOld[i - 1] === tNew[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = dp[i - 1][j] > dp[i][j - 1] ? dp[i - 1][j] : dp[i][j - 1];
      }
    }
  }

  // Backtrack LCS
  let i = n, j = m;
  const lcsIndices: [number, number][] = [];
  while (i > 0 && j > 0) {
    if (tOld[i - 1] === tNew[j - 1]) {
      lcsIndices.push([i - 1, j - 1]);
      i--;
      j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }
  
  lcsIndices.reverse(); // Now in chronological order

  const chunks: DiffChunk[] = [];
  let oldPtr = 0;
  let newPtr = 0;

  for (const [oIdx, nIdx] of lcsIndices) {
    // Collect skipped old lines -> removed
    if (oIdx > oldPtr) {
      chunks.push({
        removed: true,
        count: oIdx - oldPtr,
        lines: oldLines.slice(oldPtr, oIdx)
      });
    }

    // Collect skipped new lines -> added
    if (nIdx > newPtr) {
      chunks.push({
        added: true,
        count: nIdx - newPtr,
        lines: newLines.slice(newPtr, nIdx)
      });
    }

    // Identical line
    const last = chunks[chunks.length - 1];
    if (last && !last.added && !last.removed) {
      last.count++;
      last.lines.push(newLines[nIdx]);
    } else {
      chunks.push({ count: 1, lines: [newLines[nIdx]] });
    }

    oldPtr = oIdx + 1;
    newPtr = nIdx + 1;
  }

  // Trailing leftovers
  if (oldPtr < n) {
    chunks.push({
      removed: true,
      count: n - oldPtr,
      lines: oldLines.slice(oldPtr, n)
    });
  }
  if (newPtr < m) {
    chunks.push({
      added: true,
      count: m - newPtr,
      lines: newLines.slice(newPtr, m)
    });
  }

  return chunks;
}
