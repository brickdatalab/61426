// NODE-ONLY auth helpers (imported only by the Node-runtime login route — never by
// the Edge middleware). Constant-time password compare + best-effort in-memory
// per-IP rate limit.
import { createHash, timingSafeEqual } from 'node:crypto';

// Length-safe constant-time compare: hash both sides to a fixed 32 bytes first so
// timingSafeEqual never throws on length mismatch and no length is leaked.
export function passwordMatches(input: string, expected: string): boolean {
  if (!expected) return false;
  const a = createHash('sha256').update(input).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

// Best-effort per-IP attempt cap. NOTE: in-memory only — on Vercel this is per
// serverless instance, so it is not a global limit. It raises the cost of casual
// brute force; the real defense is the constant-time compare + a strong password.
const attempts = new Map<string, { count: number; first: number }>();
const WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 10;

export function rateLimited(ip: string): boolean {
  const now = Date.now();
  const rec = attempts.get(ip);
  if (!rec || now - rec.first > WINDOW_MS) {
    attempts.set(ip, { count: 1, first: now });
    return false;
  }
  rec.count += 1;
  return rec.count > MAX_ATTEMPTS;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
