#!/usr/bin/env node
// Merge Arena — artifacts-mode end-to-end demo orchestrator.
//
// Runs a REAL task against the deployed worker with REAL Artifacts repos:
//   1. POST /task                       -> baseline repo (+ full-access token)
//   2. git clone baseline, push seeds   -> agents are real git clients
//   3. [optional] create artifacts.repo push -> queue event subscription
//   4. POST /task/:id/agents           -> per-agent forks (+ write tokens)
//   5. per agent: clone fork, edit, push, POST /submit (concurrently)
//   6. conflict -> arena -> POST /decide (human pick)
//   7. push the merged result to the baseline repo (CI push event fires)
//   8. poll GET /task/:id/ci, flip the run to passed
//   9. POST /task/:id/teardown          -> delete all task repos
//
// Usage:
//   node scripts/artifacts-demo.mjs [--api URL] [--winner agent-3] [--with-ci] [--keep]
//
// Exit codes: 0 = full pass, 1 = failed (state left for inspection unless --keep=false default teardown on success only).

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const API = arg("--api") ?? "https://merge-arena.ionicerrrrscode.workers.dev";
const WINNER = arg("--winner") ?? "agent-3";
const WITH_CI = process.argv.includes("--with-ci");
const KEEP = process.argv.includes("--keep");
const ACCOUNT = "a033f537fb6f4e434bd01b69e99b9e70";
const QUEUE_ID = "56c624d944c74a62aaca402b4050823c";
const CFPY = "/home/hatch/workspace/skills/cloudflare/bin/cf.py";

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const workdir = mkdtempSync(join(tmpdir(), "arena-demo-"));
const proxyArgs = [];
if (process.env.https_proxy) {
  proxyArgs.push("-c", `http.proxy=${process.env.https_proxy}`, "-c", `https.proxy=${process.env.https_proxy}`);
}

function git(dir, args, input) {
  const r = spawnSync("git", [...proxyArgs, ...args], {
    cwd: dir, input, encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true" },
  });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || r.stdout).trim().slice(0, 400)}`);
  }
  return (r.stdout || "").trim();
}

// checkout <branch>, creating it only if it does not exist yet (empty clones
// need -b; clones of seeded repos already have it).
function ensureBranch(dir, branch) {
  const check = spawnSync("git", ["rev-parse", "--verify", branch], { cwd: dir, encoding: "utf8" });
  if (check.status === 0) git(dir, ["checkout", branch]);
  else git(dir, ["checkout", "-b", branch]);
}

async function api(path, method = "GET", body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (res.status >= 400) throw new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  return json;
}

// Token auth for the Artifacts git remote: try token-as-userinfo first, then
// Bearer extraheader.
function authedRemote(remote, token) {
  const u = new URL(remote);
  return [
    `${u.protocol}//${encodeURIComponent(token)}@${u.host}${u.pathname}`,
    null, // sentinel: use extraheader variant
  ];
}
function cloneWithAuth(remote, token, dest) {
  const [u1] = authedRemote(remote, token);
  try {
    git(workdir, ["clone", u1, dest]);
    return;
  } catch (e1) {
    const u = new URL(remote);
    const bare = `${u.protocol}//${u.host}${u.pathname}`;
    const r = spawnSync("git", [...proxyArgs, "-c",
      `http.extraHeader=Authorization: Bearer ${token}`, "clone", bare, dest],
      { cwd: workdir, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    if (r.status !== 0) throw new Error(`clone failed both ways: ${String(e1.message).slice(0, 200)} | ${(r.stderr || "").trim().slice(0, 200)}`);
    // persist the header so push/fetch keep working
    git(dest, ["config", "http.extraHeader", `Authorization: Bearer ${token}`]);
  }
}

// --- scenario: 3 agents, ada+grace disjoint, hopper conflicts with ada ------
const SEED = {
  "src/app.ts": 'export function greet(name: string): string {\n  return `Hello, ${name}!`;\n}\n',
  "README.md": "# Merge Arena\n\nAgent-native merge queue.\n",
};
const EDITS = {
  // agent name -> {path -> new content} + rationale + files_touched
  ada: {
    files: { "src/app.ts": SEED["src/app.ts"].replace("Hello", "Hi") },
    rationale: "friendlier greeting: Hi instead of Hello",
  },
  grace: {
    files: { "NOTES.md": "# design notes\n\n- arena shows merged-so-far vs newcomer\n" },
    rationale: "add design notes file",
  },
  hopper: {
    files: { "src/app.ts": SEED["src/app.ts"].replace("Hello", "Hey") },
    rationale: "casual greeting: Hey instead of Hello",
  },
};

const step = (n, msg) => console.log(`\n### ${n}. ${msg}`);

async function main() {
  let taskId, baseline, agents, subName;
  try {
    step(1, "create task (baseline repo only)");
    const t = await api("/task", "POST", { brief: "pick the best greeting", base: { files: SEED } });
    taskId = t.task_id; baseline = t.baseline;
    console.log(`- task ${taskId}, baseline repo ${baseline.repo}`);

    step(2, "orchestrator pushes seed files to the baseline");
    const seedDir = join(workdir, "seed");
    mkdirSync(seedDir, { recursive: true });
    cloneWithAuth(baseline.remote, baseline.token, seedDir);
    for (const [p, c] of Object.entries(SEED)) {
      const fp = join(seedDir, p);
      mkdirSync(join(seedDir, p.split("/").slice(0, -1).join("/")), { recursive: true });
      writeFileSync(fp, c);
    }
    ensureBranch(seedDir, "main");
    git(seedDir, ["add", "-A"]);
    git(seedDir, ["-c", "user.email=demo@merge-arena", "-c", "user.name=arena-demo", "commit", "-m", "seed"]);
    git(seedDir, ["push", "-u", "origin", "main"]);
    console.log("- seeds pushed to main");

    if (WITH_CI) {
      step("3", "create artifacts.repo push -> queue event subscription");
      subName = `arena-${taskId}-pushed`;
      const params = JSON.stringify({ namespace: "merge-arena", repo_name: baseline.repo });
      const subArgs = ["event-subscription-create", ACCOUNT, QUEUE_ID, "--name", subName,
        "--source-type", "artifacts.repo", "--events", "pushed", "--source-params", params];
      // cf.py plan-only exits 2 by design (nothing executed); that is success here.
      const planRun = spawnSync("python3", [CFPY, ...subArgs], { encoding: "utf8" });
      if (planRun.status !== 2 || !planRun.stdout.includes("PLAN ONLY")) {
        throw new Error(`cf.py plan failed (status ${planRun.status}): ${(planRun.stderr || planRun.stdout).slice(0, 400)}`);
      }
      const m = /Plan file\s*:\s*(\S+)/.exec(planRun.stdout);
      if (!m) throw new Error("could not parse plan file from cf.py output");
      const goRun = spawnSync("python3",
        [CFPY, ...subArgs, "--go", "--plan", m[1]], { encoding: "utf8" });
      if (goRun.status !== 0 || !goRun.stdout.includes("EXECUTED")) {
        throw new Error(`cf.py --go failed (status ${goRun.status}): ${(goRun.stderr || goRun.stdout).slice(0, 400)}`);
      }
      console.log(`- subscription ${subName} created`);
    }

    step(4, "create agents (forks + tokens)");
    const a = await api(`/task/${taskId}/agents`, "POST", { agents: ["ada", "grace", "hopper"] });
    agents = a.agents;
    for (const ag of agents) console.log(`- ${ag.name}: ${ag.branch}`);
    // KV is eventually consistent: wait until the agents are visible on the
    // task record before submitting, or submits can 400 on a stale read.
    for (let i = 0; i < 30; i++) {
      const t = await api(`/task/${taskId}`);
      if ((t.agents?.length ?? 0) >= agents.length) break;
      await new Promise((r) => setTimeout(r, 2000));
    }

    step(5, "3 agents clone, edit, push, submit CONCURRENTLY");
    const results = await Promise.all(agents.map(async (ag) => {
      const dir = join(workdir, ag.agent_id);
      mkdirSync(dir, { recursive: true });
      cloneWithAuth(ag.remote, ag.git_token, dir);
      const spec = EDITS[ag.name];
      for (const [p, c] of Object.entries(spec.files)) {
        const fp = join(dir, p);
        mkdirSync(join(dir, p.split("/").slice(0, -1).join("/")), { recursive: true });
        writeFileSync(fp, c);
      }
      ensureBranch(dir, "main");
      git(dir, ["add", "-A"]);
      git(dir, ["-c", "user.email=demo@merge-arena", "-c", "user.name=arena-demo",
        "commit", "-m", `${ag.name}: ${spec.rationale}`]);
      git(dir, ["push", "-u", "origin", "main"]);
      const s = await api(`/task/${taskId}/submit`, "POST", {
        agent_id: ag.agent_id, token: ag.token, ref: "main",
        files_touched: Object.keys(spec.files), rationale: spec.rationale,
      });
      return { name: ag.name, agent_id: ag.agent_id, ...s };
    }));
    for (const r of results) console.log(`- ${r.name}: ${r.status}`);

    step("5b", "drive folds to convergence (concurrent submits may interleave)");
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let cur;
    for (let i = 0; i < 30; i++) {
      cur = await api(`/task/${taskId}`);
      if (["arena", "merged", "resolved"].includes(cur.status)) break;
      const folded = cur.folded?.length ?? 0;
      if (folded >= agents.length) break;
      console.log(`- fold poll ${i + 1}: ${folded}/${agents.length} folded`);
      await api(`/task/${taskId}/fold`, "POST", {});
      await sleep(2000);
    }
    cur = await api(`/task/${taskId}`);
    console.log(`- converged: status=${cur.status}, folded=${cur.folded?.length}/${agents.length}`);
    if (cur.status !== "arena") {
      throw new Error(`expected a conflict -> arena, got ${cur.status}`);
    }

    step(6, "arena -> human pick");
    const arena = await api(`/task/${taskId}/arena`);
    console.log(`- status ${arena.status}, conflict: ${arena.conflicts[0].path} ` +
      `(${arena.conflicts[0].a_name} vs ${arena.conflicts[0].b_name})`);
    const d = await api(`/task/${taskId}/decide`, "POST",
      { winner_agent_id: WINNER, rationale: "demo human pick", decided_by: "demo-script" });
    console.log(`- decided: ${d.status}, winner ${d.winner_agent_id}`);

    step(7, "push the merged result to the baseline repo");
    const task = await api(`/task/${taskId}`);
    const merged = task.merged_files || {};
    // apply the human decision: winner's version wins conflicted files
    for (const c of task.conflicts || []) {
      const win = agents.find((x) => x.agent_id === WINNER);
      const wdir = join(workdir, win.agent_id);
      const content = execFileSync("git", [...proxyArgs, "show", `origin/main:${c.path}`],
        { cwd: wdir, encoding: "utf8" });
      merged[c.path] = content;
    }
    const finDir = join(workdir, "final");
    mkdirSync(finDir, { recursive: true });
    cloneWithAuth(baseline.remote, baseline.token, finDir);
    ensureBranch(finDir, "main");
    for (const [p, c] of Object.entries(merged)) {
      const fp = join(finDir, p);
      mkdirSync(join(finDir, p.split("/").slice(0, -1).join("/")), { recursive: true });
      writeFileSync(fp, c);
    }
    git(finDir, ["add", "-A"]);
    git(finDir, ["-c", "user.email=demo@merge-arena", "-c", "user.name=arena-demo",
      "commit", "-m", `merge-arena: resolved task ${taskId}, winner ${WINNER}`]);
    git(finDir, ["push", "origin", "main"]);
    console.log("- merged result pushed to baseline main");

    if (WITH_CI) {
      step(8, "CI: wait for the push event -> queue -> ci record");
      let runs = [];
      for (let i = 0; i < 24; i++) {
        await new Promise((r) => setTimeout(r, 5000));
        const ci = await api(`/task/${taskId}/ci`);
        runs = ci.runs || [];
        if (runs.length > 0) break;
      }
      if (runs.length === 0) throw new Error("no CI run recorded after 2 minutes");
      console.log(`- CI runs: ${runs.map((r) => `${String(r.sha).slice(0, 8)}:${r.status}`).join(", ")}`);
      const sha = runs[0].sha;
      await api(`/task/${taskId}/ci/${sha}`, "POST", {
        status: "passed", preview_url: `https://merge-arena.ionicerrrrscode.workers.dev/task/${taskId}/arena`,
      });
      console.log("- test runner reported: passed");
    }

    step(9, "teardown: delete all task repos");
    if (!KEEP) {
      await api(`/task/${taskId}/teardown`, "POST", {});
      console.log("- repos deleted, task record dropped");
    } else {
      console.log("- kept (--keep)");
    }

    console.log("\n### Demo complete: real Artifacts repos, real git pushes, real conflict, human resolved it.");
  } catch (e) {
    console.error("\nDEMO FAILED:", e.message);
    if (taskId) console.error(`task ${taskId} left for inspection (re-run with --keep to skip teardown)`);
    process.exitCode = 1;
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

main();
