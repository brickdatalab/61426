'use client';

import { COLORS, type Row } from './types';

const CONV_TICKS = 31;

function fmtK(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  const s = v >= 0 ? '+' : '-';
  if (a >= 1_000_000) return s + (a / 1_000_000).toFixed(2) + 'M';
  if (a >= 1000) return s + (a / 1000).toFixed(1) + 'k';
  return s + a;
}
const sgn = (v: number) => (v >= 0 ? '+' : '');
const cls = (v: number | null | undefined) => (v == null ? '' : v > 0 ? 'pos' : v < 0 ? 'neg' : '');

function Metric({ k, value, sub, valueClass }: { k: string; value: string; sub?: string; valueClass?: string }) {
  const color = valueClass === 'pos' ? COLORS.up : valueClass === 'neg' ? COLORS.down : COLORS.txt;
  return (
    <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.line}`, borderRadius: 10, padding: '9px 10px' }}>
      <div style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: '.4px', color: COLORS.dim }}>{k}</div>
      <div style={{ fontSize: 16, fontWeight: 600, marginTop: 3, fontFamily: 'ui-monospace, monospace', color }}>{value}</div>
      {sub != null && <div style={{ fontSize: 10, color: COLORS.dim, marginTop: 2, fontFamily: 'ui-monospace, monospace' }}>{sub}</div>}
    </div>
  );
}

// Mirrors the v6 metric row + conviction lock. Lock = run >= 31 ticks at the
// same directional signal, agreeing with a fat cushion (|cushion| >= max(10, 0.5*vol_1m)).
export default function ConvictionCard({ rows }: { rows: Row[] }) {
  const last = rows.length ? rows[rows.length - 1] : null;
  const sig = last?.signal ?? null;

  // trailing consecutive run at the current signal
  let run = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].signal === sig && sig != null) run++;
    else break;
  }

  const cush = last?.cushion ?? null;
  const vol = last?.vol_1m ?? null;
  const dir = sig === 'UP' || sig === 'DOWN';
  const agrees = dir && cush != null && cush !== 0 && (sig === 'UP') === (cush > 0);
  const fighting = dir && cush != null && cush !== 0 && !agrees;
  const fat = cush != null && Math.abs(cush) >= Math.max(10, 0.5 * (vol ?? 20));
  const locked = agrees && fat && run >= CONV_TICKS;

  const sigColor = sig === 'UP' ? COLORS.up : sig === 'DOWN' ? COLORS.down : COLORS.txt;
  const trackFill = fighting ? COLORS.flat : sig === 'UP' ? COLORS.up : COLORS.down;
  const runLabel = locked
    ? 'HIGH CONVICTION · ×' + run
    : fighting
      ? '×' + run + ' · fighting price'
      : '×' + run + ' ticks';

  const sigCardBorder = locked ? (sig === 'UP' ? COLORS.up : COLORS.down) : COLORS.line;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, minmax(0, 1fr))', gap: 9, marginBottom: 12 }}>
      <Metric k="Cushion" value={cush == null ? '—' : sgn(cush) + cush.toFixed(1)} sub={`Δ10s ${last?.cush_d10 != null ? sgn(last.cush_d10) + last.cush_d10.toFixed(1) : '—'}`} valueClass={cls(cush)} />
      <Metric k="CVD since open" value={fmtK(last?.cvd_since_open)} valueClass={cls(last?.cvd_since_open)} />
      <Metric k="CVD Δ5s" value={fmtK(last?.cvd_d5)} valueClass={cls(last?.cvd_d5)} />
      <Metric k="CVD Δ10s" value={fmtK(last?.cvd_d10)} valueClass={cls(last?.cvd_d10)} />
      <Metric k="CVD Δ60s" value={fmtK(last?.cvd_d60)} valueClass={cls(last?.cvd_d60)} />
      <div style={{ background: COLORS.panel, border: `1px solid ${sigCardBorder}`, borderRadius: 10, padding: '9px 10px' }}>
        <div style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: '.4px', color: COLORS.dim }}>Signal</div>
        <div style={{ fontSize: 16, fontWeight: 600, marginTop: 3, fontFamily: 'ui-monospace, monospace', color: sigColor }}>{sig ?? '—'}</div>
        {dir && (
          <div style={{ height: 3, borderRadius: 2, background: COLORS.line, marginTop: 5, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${Math.min(100, (100 * run) / CONV_TICKS)}%`, borderRadius: 2, background: trackFill }} />
          </div>
        )}
        <div style={{ fontSize: 10, color: locked ? COLORS.txt : COLORS.dim, marginTop: 2, fontFamily: 'ui-monospace, monospace' }}>{runLabel}</div>
      </div>
    </div>
  );
}
