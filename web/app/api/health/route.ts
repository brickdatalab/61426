export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { vmRequest } from '@/lib/vm';

export async function GET() {
  const t0 = Date.now();
  try {
    const r = await vmRequest('/runs');
    return NextResponse.json({ ok: r.status === 200, status: r.status, latencyMs: Date.now() - t0 });
  } catch (e) {
    return NextResponse.json({
      ok: false,
      error: String((e as Error)?.message || e),
      latencyMs: Date.now() - t0,
    });
  }
}
