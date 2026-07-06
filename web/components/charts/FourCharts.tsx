'use client';

import { useState } from 'react';
import LineCanvas from './LineCanvas';
import { COLORS, type Row } from './types';

type ImbMode = 'imb' | 'cvd5' | 'cvd60' | 'cush';

function ChartCard({
  title,
  children,
  select,
  legend,
}: {
  title?: string;
  children: React.ReactNode;
  select?: React.ReactNode;
  legend?: React.ReactNode;
}) {
  return (
    <div
      style={{
        background: COLORS.panel,
        border: `1px solid ${COLORS.line}`,
        borderRadius: 12,
        padding: 12,
      }}
    >
      {select ?? (
        <h3
          style={{
            margin: '0 0 6px',
            fontSize: 11,
            textTransform: 'uppercase',
            letterSpacing: '.6px',
            color: COLORS.dim,
          }}
        >
          {title}
        </h3>
      )}
      {children}
      {legend}
    </div>
  );
}

// 2x2 grid mirroring the v6 dashboard panels:
//  1) CVD 1m — net flow (cvd)
//  2) CVD 10s — delta flow (cvd_d10)
//  3) Bar flow — CVD since open (cvd_since_open)
//  4) swappable: Binance vs Poly imbalance / CVD d5 / CVD d60 / cushion
export default function FourCharts({ rows }: { rows: Row[] }) {
  const [mode, setMode] = useState<ImbMode>('imb');

  const cvd = rows.map((r) => (r.cvd ?? null));
  const d10 = rows.map((r) => (r.cvd_d10 ?? null));
  const sinceOpen = rows.map((r) => (r.cvd_since_open ?? null));
  const btcImb = rows.map((r) => (r.btc_imb ?? null));
  const polyImb = rows.map((r) => (r.poly_imb ?? null));
  const d5 = rows.map((r) => (r.cvd_d5 ?? null));
  const d60 = rows.map((r) => (r.cvd_d60 ?? null));
  const cush = rows.map((r) => (r.cushion ?? null));

  const legendItem = (color: string, label: string) => (
    <span>
      <b style={{ display: 'inline-block', width: 10, height: 2, verticalAlign: 'middle', marginRight: 4, background: color }} />
      {label}
    </span>
  );

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
        gap: 14,
        marginBottom: 14,
      }}
    >
      <ChartCard title="CVD 1m — net flow">
        <LineCanvas series={[{ values: cvd, color: COLORS.cvd }]} />
      </ChartCard>
      <ChartCard title="CVD 10s — delta flow">
        <LineCanvas series={[{ values: d10, color: COLORS.poly }]} />
      </ChartCard>
      <ChartCard title="Bar flow — CVD since open">
        <LineCanvas series={[{ values: sinceOpen, color: COLORS.up }]} />
      </ChartCard>
      <ChartCard
        select={
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as ImbMode)}
            style={{
              background: 'transparent',
              border: `1px solid ${COLORS.line}`,
              color: COLORS.dim,
              padding: '3px 8px',
              borderRadius: 5,
              font: '11px ui-monospace, Menlo, monospace',
              textTransform: 'uppercase',
              letterSpacing: '.6px',
              margin: '0 0 6px',
              cursor: 'pointer',
            }}
          >
            <option value="imb">Binance imb vs Poly imb</option>
            <option value="cvd5">CVD 5s delta</option>
            <option value="cvd60">CVD 60s delta</option>
            <option value="cush">Cushion</option>
          </select>
        }
        legend={
          mode === 'imb' ? (
            <div style={{ display: 'flex', gap: 12, fontSize: 10, color: COLORS.dim, marginTop: 6, fontFamily: 'ui-monospace, monospace' }}>
              {legendItem(COLORS.bin, 'Binance')}
              {legendItem(COLORS.poly, 'Polymarket')}
            </div>
          ) : undefined
        }
      >
        {mode === 'imb' && (
          <LineCanvas series={[{ values: btcImb, color: COLORS.bin }, { values: polyImb, color: COLORS.poly }]} />
        )}
        {mode === 'cvd5' && <LineCanvas series={[{ values: d5, color: COLORS.poly }]} />}
        {mode === 'cvd60' && <LineCanvas series={[{ values: d60, color: COLORS.poly }]} />}
        {mode === 'cush' && <LineCanvas series={[{ values: cush, color: COLORS.up }]} />}
      </ChartCard>
    </div>
  );
}
