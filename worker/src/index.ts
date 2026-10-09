import { Hono } from "hono";

type Env = {
  // Future: STATE_KV, Artifacts REPO binding (deploy phase only)
};

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) =>
  c.json({
    service: "merge-arena",
    status: "ok",
    version: "0.1.0",
    endpoints: ["GET /", "POST /task (planned)"],
  }),
);

// Planned: accept a task brief, fork a per-agent worktree from the
// Artifacts-backed repo, and hand each agent a scoped Git token + brief.
// Currently a stub — worker-core phase implements it.
app.post("/task", (c) =>
  c.json({ error: "not yet implemented", phase: "worker-core" }, 501),
);

export default app;
