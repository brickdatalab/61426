'use client';

import { COLORS, type Row } from './types';

// Pooled (LIVE+BQ) tier accuracy, BTC 5m, late:false calls
// (v6/analysis/2026-07-05-v6-basis.md §5). Display-only.
const TIER_ACC: Record<string, string> = { strong: '87%', qualified: '80%', lean: '60%' };
const TIER_LABEL: Record<string, string> = { strong: '≥3× floor', qualified: '≥2× floor', lean: 'lean' };
const TIP =
  'measured BTC 5m only, pooled LIVE+BQ, late:false calls (v6/analysis/2026-07-05-v6-basis.md §5): ' +
  'strong 96.2% live n=26 / 75.0% BQ-OOS n=20 (pooled 87.0% n=46); ' +
  'qualified 84.6% live n=13 / 76.5% BQ-OOS n=17 (pooled 80.0% n=30); ' +
  'lean 62.0% live n=100 / 57.1% BQ-OOS n=98 (pooled 59.6% n=198)';

// The early call latches once per bar; the latest non-null early_call in the
// rows is the latched call for this bar.
export default function EarlyCallBadge({ rows }: { rows: Row[] }) {
  let call: Row | null = null;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].early_call) { call = rows[i]; break; }
  }
  if (!call || !call.early_call) return null;

  const side = call.early_call;
  const tier = call.early_tier || 'lean';
  const arrow = side === 'UP' ? '▲' : '▼';
  const color = side === 'UP' ? COLORS.up : COLORS.down;
  const tierTxt = `${TIER_LABEL[tier] ?? tier} (${TIER_ACC[tier] ?? '—'})`;

  return (
    <div title={TIP} style={{ marginTop: 6, fontSize: 12, fontWeight: 700, letterSpacing: '.3px', color }}>
      EARLY CALL {arrow} {side} · {tierTxt}
    </div>
  );
}
