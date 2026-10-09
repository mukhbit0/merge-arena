# ci-worker (planned)

The CI worker subscribes to Merge Arena merge events and, for each merged
candidate:

1. Runs the repo's test suite against the merged tree.
2. Builds a deploy preview of the merged result.
3. Reports pass/fail back to the Merge Arena worker (`merge-arena`), which
   surfaces it in the arena view next to the winning pick.

Planned as a separate Cloudflare Worker (`merge-arena-ci`) so CI load stays
isolated from the merge queue. Implementation arrives in the **ci** phase.
