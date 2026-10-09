# Merge Arena — demo video voiceover (FULL, continuous narration)

Calm, peer-to-peer explainer tone. Each shot's narration fills the shot —
no dead air. Pacing ~140 wpm. Shot durations: 20 / 30 / 50 / 80 / 40 / 40 / 40.

## Shot 1 — 0:00–0:20 — Title card (~18s, ~42 words)

When three AI agents write code at the same time, who wins? Merge Arena is
a merge queue built for agents — running on Cloudflare Workers and
Artifacts. This is a real demo: three agents, one task, pushing at the
exact same moment.

## Shot 2 — 0:20–0:50 — Architecture card (~28s, ~65 words)

Here's how it works. One task, one baseline repo, one fork per agent. Each
agent gets a short-lived write token scoped to its own fork — it can only
touch its own work. Agents are real git clients: they branch, commit, and
push like any developer would. When pushes land, the queue compares them.
Clean merges go straight in. Anything that collides goes to the arena,
where every candidate is judged side by side.

## Shot 3 — 0:50–1:40 — Terminal: three concurrent pushes (~48s, ~112 words)

Watch this. Three agents push at the same time — not staged, not
sequential, actually concurrent. Ada appends a farewell helper at the end
of the file: clean, no overlap. Grace rewrites the greeting from Hello to
Hi: also clean, auto-merged. But Hopper rewrites the same line differently
— Hey instead of Hello. Same line, two agents, two different answers.
That's a real conflict. Two merges land automatically. Hopper's can't be
resolved by git alone, so it goes to the arena. This is the moment most
merge queues either pick wrong or make a human read three diffs. Merge
Arena does something else.
Look at the timing: all three pushes hit the queue within the same second. Concurrent agents don't line up — they fire together. That's the whole problem this project exists to solve.


## Shot 4 — 1:40–3:00 — Arena UI live: candidates + conflict view (~78s, ~182 words)

This is the arena. Every candidate is laid out with its full diff and its
rationale — what the agent changed and why it thought it was right. The
conflict is shown side by side: the merged result so far versus the
newcomer. Nothing is hidden. You can see Ada's helper, Grace's friendlier
greeting, and Hopper's casual alternative, all in one view. The arena
doesn't guess which change is better — it presents the evidence. Each
candidate carries its author's reasoning, the exact lines it touched, and
where it overlaps with the others. For an agent-native workflow, this
matters: the next agent in the loop — or the human reviewing — gets the
full picture instead of a silent auto-resolution that might have picked the
wrong greeting. The queue holds the task in the arena state until a
decision is made. No partial merges, no lost work, no force-push roulette.
And because every candidate keeps its rationale, the arena doubles as a teaching tool: junior agents — or junior developers — can see not just what won, but what the alternatives were and why they lost. The conflict view stays live the whole time the task is in arena state, updating if new pushes arrive. Nothing times out silently, nothing gets garbage-collected while you're still deciding.


## Shot 5 — 3:00–3:40 — Arena UI: CI runs table (~38s, ~89 words)

Meanwhile, every push fires a repository event into a queue. The CI worker
picks it up, records the run, and the test runner reports back. Here you
can see the run for this task: received, then passed — twenty-one tests
green — with a deploy preview link for the result. You know exactly what's
tested before anyone decides anything. CI isn't a separate dashboard you
have to go check; it's part of the arena record, attached to the same
task, visible right next to the candidates.

## Shot 6 — 3:40–4:20 — Arena UI: human picks winner, resolved view (~38s, ~89 words)

Now a human picks the winner. One click on Hopper's candidate, with a
recorded rationale. The task resolves instantly — the decision, who made
it, and why are all written into the audit trail. Not in a chat log, not
in someone's memory — in the record, attached to the merge itself. The
losing candidates aren't deleted; they're preserved as part of the task
history, so the whole decision can be replayed later. That's the whole
loop: agents propose, CI verifies, humans decide, and everything is
recorded.

## Shot 7 — 4:20–5:00 — Outro card (~38s, ~89 words)

Merge Arena: auto-merge when it's clean, a human arena when it's not.
Built on Cloudflare Workers, Artifacts, and Queues — the same primitives
this competition is about. The code is open source, MIT licensed, and the
whole demo you just watched runs against a live worker. If you're building
agent workflows that write code, you already know the merge problem. Merge
Arena is one answer. Thanks for watching.
The demo you watched ran three real agents against a live Cloudflare worker — real git pushes, real queue events, real CI. No mocks, no staging. That's the bar for agent infrastructure: it has to work when everyone's pushing at once.
