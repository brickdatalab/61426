// EDGE runtime (default). WebCrypto-only session verification — must NOT import
// node:crypto, lib/auth-node, or lib/vm (they use node APIs and would break the
// Edge build). Allows /login and /api/login through unauthenticated; everything
// else requires a valid session cookie.
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { verifySession, SESSION_COOKIE } from '@/lib/session';

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Public paths — always allowed through.
  if (pathname === '/login' || pathname === '/api/login') {
    return NextResponse.next();
  }

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const ok = await verifySession(process.env.SESSION_SECRET || '', token);
  if (ok) return NextResponse.next();

  // Unauthenticated: API paths get 401 JSON; everything else redirects to /login.
  if (pathname.startsWith('/api/')) {
    return new NextResponse(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }
  const url = req.nextUrl.clone();
  url.pathname = '/login';
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
