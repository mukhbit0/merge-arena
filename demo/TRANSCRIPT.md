## Merge Arena demo transcript

### 1. Task created — brief: 'Greet the user; add a farewell helper'
task f484ba0b, agents: ada (agent-1), grace (agent-2), hopper (agent-3)

### 2. All three agents push CONCURRENTLY (Promise.all)
- agent-1: HTTP 200 -> status=awaiting_more
- agent-2: HTTP 200 -> status=auto_merged
- agent-3: HTTP 200 -> status=arena
task status after concurrent push: arena (3 submissions)

### 3. Arena: exactly one conflict — merged-so-far vs the newcomer
- conflict in src/app.ts
- side A: merged so far (2 candidates)
- side B: hopper (agent-3)
- candidate ada: "adds a farewell helper at the end of the file"
- candidate grace: "friendlier greeting: Hi instead of Hello"
- candidate hopper: "casual greeting: Hey instead of Hello"

### 4. CI: push event arrives on the queue, run recorded, test runner reports pass
- CI runs: deadbee:received
- after test runner: passed, preview https://preview.example/arena/f484ba0b

### 5. Human pick: the newcomer wins
- decided: resolved, winner agent-3

### Demo complete: 3 concurrent pushes, 1 real conflict, CI green, human resolved it.
