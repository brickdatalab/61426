'use client';

import { COLORS, type Row } from './types';

// Reconstructs the v6 "flowing pressure" bar from the latest row.
// pressure = clamp( (imb_ewma ?? comb) * 0.7 + flipPush * 0.3, -1, 1 )
// flipPush pushes AGAINST the current side: UP => -p_flip, DOWN => +p_flip.
function pressureOf(r: Row | null): number {
  if (!r) return 0;
  const base = r.imb_ewma ?? r.comb ?? 0;
  const pf = r.p_flip ?? 0;
  const flipPush = r.signal === 'UP' ? -pf : r.signal === 'DOWN' ? pf : 0;
  return Math.max(-1, Math.min(1, base * 0.7 + flipPush * 0.3));
}

export default function PressureBar({ rows }: { rows: Row[] }) {
  const last = rows.length ? rows[rows.length - 1] : null;
  const sig = (last?.signal || 'WAIT') as string;
  const pressure = pressureOf(last);
  const npct = 50 + pressure * 48;

  const fillStyle: React.CSSProperties =
    pressure >= 0
      ? { left: '50%', width: `${pressure * 48}%`, background: 'rgba(46,194,126,.45)' }
      : { left: `${50 + pressure * 48}%`, width: `${-pressure * 48}%`, background: 'rgba(255,93,108,.45)' };

  const sigColor = sig === 'UP' ? COLORS.up : sig === 'DOWN' ? COLORS.down : sig === 'MIXED' ? COLORS.flat : COLORS.dim;
  const flip = last?.p_flip;
  const bimb = last?.btc_imb;
  const pimb = last?.poly_imb;
  const momz = last?.mom_z;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 18,
        padding: '14px 18px',
        borderRadius: 12,
        border: `1px solid ${COLORS.line}`,
        background: COLORS.panel,
        marginBottom: 14,
        flexWrap: 'wrap',
      }}
    >
      <div style={{ flex: '0 0 430px', maxWidth: 430, minWidth: 0 }}>
        <div style={{ fontSize: 26, fontWeight: 800, letterSpacing: 1, lineHeight: 1.1, color: sigColor }}>
          {sig === 'UP' ? 'UP' : sig === 'DOWN' ? 'DOWN' : sig === 'MIXED' ? 'MIXED' : '—'}
        </div>
        <div style={{ fontSize: 11, color: COLORS.dim, fontFamily: 'ui-monospace, monospace', lineHeight: 1.5, marginTop: 4 }}>
          Binance <b style={{ color: COLORS.txt }}>{bimb == null ? '—' : bimb.toFixed(2)}</b> · Polymarket{' '}
          <b style={{ color: COLORS.txt }}>{pimb == null ? '—' : pimb.toFixed(2)}</b> · mom z
          <b style={{ color: COLORS.txt }}>{momz == null ? '—' : (momz >= 0 ? '+' : '') + momz.toFixed(1)}</b> · flip{' '}
          <b style={{ color: COLORS.txt }}>{flip == null ? '—' : Math.round(flip * 100) + '%'}</b>
          {last?.flip_alert ? <b style={{ color: COLORS.down }}> {last.flip_alert}</b> : null}
        </div>
      </div>
      <div style={{ flex: 1, minWidth: 240 }}>
        <div
          style={{
            position: 'relative',
            height: 42,
            borderRadius: 10,
            background:
              'linear-gradient(90deg,rgba(255,93,108,.22),rgba(255,93,108,.03) 45%,rgba(46,194,126,.03) 55%,rgba(46,194,126,.22))',
            border: `1px solid ${COLORS.line}`,
            overflow: 'hidden',
          }}
        >
          <div style={{ position: 'absolute', top: 0, bottom: 0, left: '50%', width: 2, background: COLORS.txt, opacity: 0.45 }} />
          <div style={{ position: 'absolute', top: 6, bottom: 6, borderRadius: 4, transition: 'all .9s cubic-bezier(.22,.61,.36,1)', ...fillStyle }} />
          <div
            style={{
              position: 'absolute',
              top: -3,
              bottom: -3,
              left: `${npct}%`,
              width: 3,
              borderRadius: 2,
              background: '#fff',
              boxShadow: '0 0 6px rgba(255,255,255,.6)',
              transition: 'left .9s cubic-bezier(.22,.61,.36,1)',
            }}
          />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: COLORS.dim, marginTop: 4 }}>
          <span>← DOWN pressure</span>
          <span>net flow + book conviction</span>
          <span>UP pressure →</span>
        </div>
      </div>
    </div>
  );
}
