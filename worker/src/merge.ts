// Pure (git-independent) overlap analysis: line-based 3-way merge.
//
// Given base text plus two candidate texts per file, reports per file whether
// the two sides' changes overlap, whether they conflict, and — when they can
// be combined — the merged text. The worker's authoritative path uses real git
// (git-backend threeWay); this module is a portable heuristic for analysis,
// previews, and future arena-ui use. No new dependencies.

export interface FileCandidates {
  base: string;
  a: string;
  b: string;
}

export interface FileMergeResult {
  /** True when both sides changed at least one common region. */
  overlap: boolean;
  /** True when overlapping changes differ (cannot auto-merge). */
  conflict: boolean;
  /** Merged text. Set only when !conflict. */
  merged?: string;
}

/** A changed region: base lines [start, end) replaced by `replacement`. */
interface Hunk {
  start: number;
  end: number;
  replacement: string[];
}

function splitLines(s: string): string[] {
  return s === "" ? [] : s.split("\n");
}

/** Changed hunks of `other` relative to `base`, via LCS (dynamic program). */
function changedHunks(base: string[], other: string[]): Hunk[] {
  const m = base.length;
  const n = other.length;
  const w = n + 1;
  const dp = new Uint32Array((m + 1) * w);
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i * w + j] =
        base[i] === other[j]
          ? dp[(i + 1) * w + j + 1] + 1
          : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  const hunks: Hunk[] = [];
  let i = 0;
  let j = 0;
  let bi = 0; // base coordinate cursor
  let cur: Hunk | null = null;
  const flush = () => {
    if (cur) {
      hunks.push(cur);
      cur = null;
    }
  };
  const open = () => {
    if (!cur) cur = { start: bi, end: bi, replacement: [] };
  };
  while (i < m && j < n) {
    if (base[i] === other[j]) {
      flush();
      i++;
      j++;
      bi++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
      open();
      cur!.end = bi + 1;
      i++;
      bi++;
    } else {
      open();
      cur!.replacement.push(other[j]);
      j++;
    }
  }
  while (i < m) {
    open();
    cur!.end = bi + 1;
    i++;
    bi++;
  }
  while (j < n) {
    open();
    cur!.replacement.push(other[j]);
    j++;
  }
  flush();
  return hunks;
}

/**
 * Do two base-coordinate ranges overlap? Pure insertions (zero-width) overlap
 * only with another insertion at the exact same point or a hunk covering it.
 */
function rangesOverlap(x: Hunk, y: Hunk): boolean {
  if (x.start === x.end && y.start === y.end) return x.start === y.start;
  if (x.start === x.end) return y.start <= x.start && x.start < y.end;
  if (y.start === y.end) return x.start <= y.start && y.start < x.end;
  return x.start < y.end && y.start < x.end;
}

function sameReplacement(x: Hunk, y: Hunk): boolean {
  return (
    x.start === y.start &&
    x.end === y.end &&
    x.replacement.length === y.replacement.length &&
    x.replacement.every((l, k) => l === y.replacement[k])
  );
}

export function mergeFile(c: FileCandidates): FileMergeResult {
  const base = splitLines(c.base);
  const ha = changedHunks(base, splitLines(c.a));
  const hb = changedHunks(base, splitLines(c.b));
  let overlap = false;
  let conflict = false;
  const usedB = new Set<number>();
  const applied: Hunk[] = [];

  for (const x of ha) {
    const hits: number[] = [];
    hb.forEach((y, yi) => {
      if (!usedB.has(yi) && rangesOverlap(x, y)) hits.push(yi);
    });
    if (hits.length === 0) {
      applied.push(x);
      continue;
    }
    overlap = true;
    const allSame = hits.every((yi) => sameReplacement(x, hb[yi]));
    if (allSame) {
      applied.push(x); // identical overlapping changes: take one
      hits.forEach((yi) => usedB.add(yi));
    } else {
      conflict = true;
    }
  }
  hb.forEach((y, yi) => {
    if (!usedB.has(yi)) applied.push(y);
  });
  if (conflict) return { overlap: true, conflict: true };

  applied.sort((p, q) => p.start - q.start || p.end - q.end);
  const out: string[] = [];
  let bi = 0;
  for (const h of applied) {
    while (bi < h.start) out.push(base[bi++]);
    out.push(...h.replacement);
    bi = Math.max(bi, h.end);
  }
  while (bi < base.length) out.push(base[bi++]);
  return { overlap, conflict: false, merged: out.join("\n") };
}

/** Per-file analysis over a map of path -> {base, a, b}. */
export function analyzeOverlap(
  files: Map<string, FileCandidates>,
): Map<string, FileMergeResult> {
  const out = new Map<string, FileMergeResult>();
  for (const [path, c] of files) out.set(path, mergeFile(c));
  return out;
}
