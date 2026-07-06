'use client';

import Link from 'next/link';
import { usePoll } from '@/lib/usePoll';
import FourCharts from '@/components/charts/FourCharts';
import PressureBar from '@/components/charts/PressureBar';
import ConvictionCard from '@/components/charts/ConvictionCard';
import EarlyCallBadge from '@/components/charts/EarlyCallBadge';
import type { Row } from '@/components/charts/types';

type Run = {
  runId: string;
  version?: string;
  slug?: string;
  rem?: number | null;
  continuousRemaining?: number | null;
  lastTick?: number | null;
};

function clock(sec: number | null | undefined): string {
  if (sec == null) return '--:--';
  const s = Math.max(0, Math.round(sec));
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}

export default function RunViewer({ runId }: { runId: string }) {
  const { data, error, loading } = usePoll<Row[]>(`/api/vm/runs/${runId}/rows?since=0`, 1500);
  const { data: runsData } = usePoll<Run[]>('/api/vm/runs', 3000);
  const rows = Array.isArray(data) ? data : [];
  const run = Array.isArray(runsData) ? runsData.find((r) => r.runId === runId) : undefined;
  const last = rows.length ? rows[rows.length - 1] : null;

  const tapeAge = last?.tape_age_ms ?? null;
  const bookAge = last?.book_age_ms ?? null;
  const recentGap = rows.slice(-20).some((r) => r?.gap === true);
  const stale = (tapeAge != null && tapeAge > 5000) || (bookAge != null && bookAge > 5000) || recentGap;

  return (
    <main style={{ padding: 16, maxWidth: 1200, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', marginBottom: 14 }}>
        <Link href="/">← runs</Link>
        <h1 style={{ fontSize: 15, margin: 0, fontWeight: 600 }}>
          {run?.version ?? ''} <span className="mono">{run?.slug ?? runId}</span>
        </h1>
        <span className="muted">rem {clock(run?.rem)}</span>
        <span className="muted">cont {run?.continuousRemaining ?? '—'}</span>
        <span className="muted">{rows.length} rows</span>
        <span className={stale ? 'bad' : 'good'}>
          {stale ? 'STALE' : 'fresh'}
          {tapeAge != null ? ` · tape ${tapeAge}ms` : ''}
          {bookAge != null ? ` · book ${bookAge}ms` : ''}
          {recentGap ? ' · gap' : ''}
        </span>
      </div>

      {error && <div className="bad">error: {error}</div>}
      {loading && !last && <div className="muted">loading…</div>}
      {!loading && !last && !error && <div className="muted">no rows yet</div>}

      {last && (
        <>
          <PressureBar rows={rows} />
          <EarlyCallBadge rows={rows} />
          <div style={{ height: 10 }} />
          <FourCharts rows={rows} />
          <ConvictionCard rows={rows} />
        </>
      )}
    </main>
  );
}
