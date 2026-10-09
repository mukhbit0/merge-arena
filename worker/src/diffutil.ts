// Small unified-diff helpers used by the HTTP routes.

/** Paths touched by a unified diff (from `diff --git` or `+++ b/` headers). */
export function filesTouchedBy(diff: string): string[] {
  const files = new Set<string>();
  for (const line of diff.split("\n")) {
    const git = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (git) {
      files.add(git[2]);
      continue;
    }
    const plus = /^\+\+\+ b\/(.+)$/.exec(line);
    if (plus && plus[1] !== "/dev/null") files.add(plus[1]);
  }
  return [...files];
}

/** Count +/- lines, ignoring the ---/+++ file headers. */
export function diffStat(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) deletions++;
  }
  return { additions, deletions };
}

/** First `n` lines of a text, for arena excerpts. */
export function excerpt(text: string, n = 20): string {
  return text.split("\n").slice(0, n).join("\n");
}
