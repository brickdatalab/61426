export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { passwordMatches, rateLimited, sleep } from '@/lib/auth-node';
import { signSession, SESSION_COOKIE } from '@/lib/session';

const MAX_AGE = 7 * 24 * 60 * 60; // seconds

export async function POST(req: NextRequest) {
  const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'local';
  if (rateLimited(ip)) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }

  let password = '';
  try {
    const body = (await req.json()) as { password?: string };
    password = body.password || '';
  } catch {
    password = '';
  }

  if (!passwordMatches(password, process.env.APP_PASSWORD || '')) {
    await sleep(300);
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const token = await signSession(process.env.SESSION_SECRET || '');
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: MAX_AGE,
  });
  return res;
}
