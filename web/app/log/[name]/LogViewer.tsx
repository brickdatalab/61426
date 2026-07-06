'use client';

import Link from 'next/link';
import { usePoll } from '@/lib/usePoll';
import FourCharts from '@/components/charts/FourCharts';
import PressureBar from '@/components/charts/PressureBar';
import ConvictionCard from '@/components/charts/ConvictionCard';
import EarlyCallBadge from '@/components/charts/EarlyCallBadge';
import type { Row } from '@/components/charts/types';

type LogDoc = { slug?: string; rows?: Row[] };

export default function LogViewer({ name }: { name: string }) {
  // Historical log is static — poll slowly just to survive a transient error.
  const { data, error, loading } = usePoll<LogDoc>(`/api/vm/logs/${encodeURIComponent(name)}`, 30000);
  const rows = Array.isArray(data?.rows) ? (data!.rows as Row[]) : [];
  const settleRow = rows.find((r) => r.settled);

  return (
    <main style={{ padding: 16, maxWidth: 1200, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', marginBottom: 14 }}>
        <Link href="/">← runs</Link>
        <h1 style={{ fontSize: 15, margin: 0, fontWeight: 600 }}>
          log <span className="mono">{data?.slug ?? name}</span>
        </h1>
        <span className="muted">{rows.length} rows</span>
        {settleRow && (
          <span className={settleRow.settled === 'UP' ? 'good' : 'bad'}>
            SETTLED {settleRow.settled}
            {settleRow.open != null && settleRow.close != null ? ` · ${settleRow.open} → ${settleRow.close}` : ''}
          </span>
        )}
      </div>

      {error && <div className="bad">error: {error}</div>}
      {loading && !rows.length && <div className="muted">loading…</div>}
      {!loading && !rows.length && !error && <div className="muted">empty log</div>}

      {rows.length > 0 && (
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
