import type { ReplyClaims } from "./types.js";

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64UrlToBytes(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return null;
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((value.length + 3) % 4);
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

export function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    diff |= l ^ r;
  }
  return diff === 0;
}

async function sha256(value: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return new Uint8Array(digest);
}

async function hmacSha256(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return new Uint8Array(sig);
}

/** Compare two strings without leaking the expected value through early length mismatches. */
export async function secretsEqual(expected: string, provided: string): Promise<boolean> {
  if (!expected || !provided) return false;
  const [left, right] = await Promise.all([sha256(expected), sha256(provided)]);
  return timingSafeEqual(left, right);
}

export async function signReplyToken(secret: string, claims: ReplyClaims): Promise<string> {
  const payload = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(claims)));
  const sig = bytesToBase64Url(await hmacSha256(secret, `v1.${payload}`));
  return `v1.${payload}.${sig}`;
}

export type VerifyResult =
  | { ok: true; claims: ReplyClaims }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

export async function verifyReplyToken(secret: string, token: string, nowMs: number): Promise<VerifyResult> {
  if (!secret) return { ok: false, reason: "malformed" };
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1" || !parts[1] || !parts[2]) {
    return { ok: false, reason: "malformed" };
  }
  const payload = parts[1];
  // Compare the canonical encoding, so a signature with different unused low
  // bits in its last character (same decoded bytes) is not a second valid token.
  const expected = new TextEncoder().encode(bytesToBase64Url(await hmacSha256(secret, `v1.${payload}`)));
  const presented = new TextEncoder().encode(parts[2]);
  if (!timingSafeEqual(expected, presented)) {
    return { ok: false, reason: "bad_signature" };
  }
  const raw = base64UrlToBytes(payload);
  if (!raw) return { ok: false, reason: "malformed" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!isReplyClaims(parsed)) return { ok: false, reason: "malformed" };
  if (nowMs >= parsed.exp * 1000) return { ok: false, reason: "expired" };
  return { ok: true, claims: parsed };
}

export function replyTokenScopeOk(
  claims: ReplyClaims,
  chatId: string,
  threadId: number | null,
): boolean {
  if (claims.chat_id !== chatId) return false;
  const claimed = claims.thread_id ?? null;
  const requested = threadId ?? null;
  return claimed === requested;
}

function isReplyClaims(value: unknown): value is ReplyClaims {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    record.v === 1 &&
    typeof record.chat_id === "string" &&
    /^-?\d+$/.test(record.chat_id) &&
    (record.thread_id === null || (typeof record.thread_id === "number" && Number.isSafeInteger(record.thread_id))) &&
    typeof record.wake_id === "string" &&
    record.wake_id.length > 0 &&
    record.wake_id.length <= 80 &&
    typeof record.exp === "number" &&
    Number.isFinite(record.exp) &&
    (record.quiet === undefined || record.quiet === true)
  );
}
