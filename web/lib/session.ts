// Edge-SAFE session cookie: HMAC-SHA256 via WebCrypto only (no node:crypto).
// Used by BOTH the Edge middleware (verify) and the Node login route (sign) so the
// algorithm matches. Token = "v1.<expiryMs>.<base64url(hmac)>".
const enc = new TextEncoder();

function toB64url(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64url(str: string): Uint8Array {
  const norm = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(norm);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

const TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function signSession(secret: string, ttlMs: number = TTL_MS): Promise<string> {
  const payload = `v1.${Date.now() + ttlMs}`;
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
  return `${payload}.${toB64url(new Uint8Array(sig))}`;
}

export async function verifySession(secret: string, token?: string | null): Promise<boolean> {
  if (!secret || !token) return false;
  const lastDot = token.lastIndexOf('.');
  if (lastDot < 0) return false;
  const payload = token.slice(0, lastDot);
  const sigStr = token.slice(lastDot + 1);
  let ok = false;
  try {
    const key = await hmacKey(secret);
    ok = await crypto.subtle.verify('HMAC', key, fromB64url(sigStr), enc.encode(payload));
  } catch {
    return false;
  }
  if (!ok) return false;
  const exp = Number(payload.split('.')[1]);
  return Number.isFinite(exp) && Date.now() < exp;
}

export const SESSION_COOKIE = 'session';
