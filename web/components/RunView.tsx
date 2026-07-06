'use client';

import { usePoll } from '@/lib/usePoll';

export type Row = {
  signal?: string | null;
  early_call?: string | null;
  early_tier?: string | null;
  rem?: number | null;
  t?: number | null;
  tape_age_ms?: number | null;
  book_age_ms?: number | null;
  gap?: boolean | null;
  cushion?: number | null;
  btc_imb?: number | null;
  poly_imb?: number | null;
};

function fmt(v: unknown): string {
  if (v === null || v === undefined) return '—';
  return String(v);
}

export default function RunView({ runId }: { runId: string }) {
  const { data, error, loading } = usePoll<Row[]>(`/api/vm/runs/${runId}/rows?since=0`);
  const rows = Array.isArray(data) ? data : [];
  const last = rows.length ? rows[rows.length - 1] : null;
  const recentGap = rows.slice(-20).some((r) => r?.gap === true);

  return (
    <div className="panel">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <strong>run {runId}</strong>
        <span className="muted">{rows.length} rows</span>
      </div>
      {error && <div className="bad">error: {error}</div>}
      {loading && !last && <div className="muted">loading…</div>}
      {!loading && !last && !error && <div className="muted">no rows yet</div>}
      {last && (
        <table style={{ borderCollapse: 'collapse', marginTop: 6 }}>
          <tbody>
            <tr>
              <td className="muted" style={{ paddingRight: 12 }}>
                signal
              </td>
              <td>{fmt(last.signal)}</td>
            </tr>
            <tr>
              <td className="muted">early call</td>
              <td>
                {fmt(last.early_call)}
                {last.early_tier ? <span className="muted"> ({last.early_tier})</span> : null}
              </td>
            </tr>
            <tr>
              <td className="muted">rem</td>
              <td>{fmt(last.rem)}</td>
            </tr>
            <tr>
              <td className="muted">last tick (t)</td>
              <td>{fmt(last.t)}</td>
            </tr>
            <tr>
              <td className="muted">tape_age_ms</td>
              <td>{fmt(last.tape_age_ms)}</td>
            </tr>
            <tr>
              <td className="muted">book_age_ms</td>
              <td>{fmt(last.book_age_ms)}</td>
            </tr>
            <tr>
              <td className="muted">recent gap</td>
              <td className={recentGap ? 'warn' : ''}>{recentGap ? 'yes' : 'no'}</td>
            </tr>
          </tbody>
        </table>
      )}
    </div>
  );
}
