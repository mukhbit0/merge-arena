// Scoped agent tokens: HMAC-SHA256 signed, base64url-encoded.
//
// Implemented on globalThis.crypto.subtle so the same code runs in the
// Cloudflare Workers runtime and in Node (tests, local dev). Async because
// subtle crypto is async everywhere.
//
// Token format: base64url(JSON payload) + "." + base64url(HMAC_SHA256(body))

export interface TokenPayload {
  taskId: string;
  agentId: string;
  scopes: string[];
  /** Epoch ms after which the token is rejected. */
  exp: number;
}

const te = new TextEncoder();
const td = new TextDecoder();

function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    te.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function issueToken(secret: string, payload: TokenPayload): Promise<string> {
  const body = b64urlEncode(te.encode(JSON.stringify(payload)));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, te.encode(body));
  return `${body}.${b64urlEncode(new Uint8Array(sig))}`;
}

/** Returns the payload on success, null on any tampering/expiry/malformation. */
export async function verifyToken(secret: string, token: string): Promise<TokenPayload | null> {
  try {
    const dot = token.indexOf(".");
    if (dot <= 0) return null;
    const body = token.slice(0, dot);
    const sig = b64urlDecode(token.slice(dot + 1));
    const key = await hmacKey(secret);
    const ok = await crypto.subtle.verify("HMAC", key, sig, te.encode(body));
    if (!ok) return null;
    const payload = JSON.parse(td.decode(b64urlDecode(body))) as TokenPayload;
    if (typeof payload.exp !== "number" || payload.exp <= Date.now()) return null;
    if (!payload.taskId || !payload.agentId || !Array.isArray(payload.scopes)) return null;
    return payload;
  } catch {
    return null;
  }
}

export interface SecretEnv {
  MERGE_ARENA_SECRET?: string;
}

let devSecret: string | null = null;

/**
 * Secret for token signing. Reads MERGE_ARENA_SECRET; without it, generates a
 * random per-process dev secret (tokens are then invalid after restart —
 * acceptable for local dev only, never rely on it in production).
 */
export function getSecret(env: SecretEnv): string {
  if (env.MERGE_ARENA_SECRET) return env.MERGE_ARENA_SECRET;
  if (!devSecret) devSecret = b64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
  return devSecret;
}
