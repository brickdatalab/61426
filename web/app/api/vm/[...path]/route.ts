export const runtime = 'nodejs';

import type { NextRequest } from 'next/server';
import { vmRequest } from '@/lib/vm';

// Allowlist of proxyable subpaths (query string stripped before matching).
const ALLOW = [/^runs$/, /^runs\/[^/]+$/, /^runs\/[^/]+\/rows$/, /^logs$/, /^logs\/[^/]+$/];

function proxy(method: string) {
  return async (req: NextRequest, ctx: { params: { path?: string[] } }) => {
    const subpath = (ctx.params.path || []).join('/');
    if (!ALLOW.some((re) => re.test(subpath))) {
      return new Response(JSON.stringify({ error: 'forbidden' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      });
    }
    const query = req.nextUrl.search || '';
    let body: string | undefined;
    if (method === 'POST') body = await req.text();
    try {
      const result = await vmRequest('/' + subpath + query, { method, body });
      return new Response(result.body, {
        status: result.status,
        headers: { 'content-type': result.contentType },
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: String((e as Error)?.message || e) }), {
        status: 502,
        headers: { 'content-type': 'application/json' },
      });
    }
  };
}

export const GET = proxy('GET');
export const POST = proxy('POST');
export const DELETE = proxy('DELETE');
