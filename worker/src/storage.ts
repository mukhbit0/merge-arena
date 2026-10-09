// Minimal KV-like storage abstraction.
//
// Two implementations:
//  - InMemoryState: default, used when no KV binding is present (local dev / tests).
//  - KVState: lazy wrapper around a Cloudflare KV binding named STATE_KV,
//    used only when the binding exists in env. Created in the deploy phase.
//
// All values are JSON-serialized so both backends behave identically.

export interface StateStore {
  get<T = unknown>(key: string): Promise<T | null>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

export class InMemoryState implements StateStore {
  private map = new Map<string, string>();

  async get<T>(key: string): Promise<T | null> {
    const raw = this.map.get(key);
    return raw === undefined ? null : (JSON.parse(raw) as T);
  }

  async put(key: string, value: unknown): Promise<void> {
    this.map.set(key, JSON.stringify(value));
  }

  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }

  async list(prefix: string): Promise<string[]> {
    return [...this.map.keys()].filter((k) => k.startsWith(prefix));
  }
}

// Minimal structural type for a Cloudflare KV binding. Kept structural (not
// workers-types) so this module stays decoupled and unit-testable.
export interface KVBindingLike {
  get(key: string, type: "text"): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  list(opts: { prefix: string }): Promise<{ keys: Array<{ name: string }> }>;
}

export class KVState implements StateStore {
  constructor(private kv: KVBindingLike) {}

  async get<T>(key: string): Promise<T | null> {
    const raw = await this.kv.get(key, "text");
    return raw === null ? null : (JSON.parse(raw) as T);
  }

  async put(key: string, value: unknown): Promise<void> {
    await this.kv.put(key, JSON.stringify(value));
  }

  async delete(key: string): Promise<void> {
    await this.kv.delete(key);
  }

  async list(prefix: string): Promise<string[]> {
    const res = await this.kv.list({ prefix });
    return res.keys.map((k) => k.name);
  }
}

export interface StateEnv {
  STATE_KV?: KVBindingLike;
  MERGE_ARENA_SECRET?: string;
}

// Module-level shared in-memory instance so dev-server requests (no binding)
// see the same state without callers having to wire a singleton.
let shared: InMemoryState | null = null;

export function getState(env: StateEnv): StateStore {
  if (env.STATE_KV) return new KVState(env.STATE_KV);
  if (!shared) shared = new InMemoryState();
  return shared;
}
