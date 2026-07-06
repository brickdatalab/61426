// Row shape emitted by the control-API rows endpoint (and stored logs). All
// fields optional/nullable — a live tick may be missing feed-derived values.
export type Row = {
  t?: string | null;
  rem?: number | null;
  btc_imb?: number | null;
  poly_imb?: number | null;
  comb?: number | null;
  cushion?: number | null;
  cvd?: number | null;
  cvd_since_open?: number | null;
  cvd_d5?: number | null;
  cvd_d10?: number | null;
  cvd_d60?: number | null;
  cush_d10?: number | null;
  mom_z?: number | null;
  mom_dir?: number | null;
  imb_ewma?: number | null;
  large_prints?: number | null;
  efficiency?: number | null;
  perp_spot_div?: number | null;
  cvd_d3m?: number | null;
  vol_1m?: number | null;
  poly_mid?: number | null;
  p_flip?: number | null;
  flip_alert?: string | null;
  signal?: string | null;
  early_call?: string | null;
  early_tier?: string | null;
  tape_age_ms?: number | null;
  book_age_ms?: number | null;
  gap?: boolean | null;
  // settle sentinel row
  settled?: string | null;
  open?: number | null;
  close?: number | null;
};

// v6 palette (from v6/updown-liquidity-overlap.html :root)
export const COLORS = {
  bin: '#5b9dff',
  poly: '#e3c75a',
  cvd: '#9b8cff',
  up: '#2ec27e',
  down: '#ff5d6c',
  flat: '#c7b94a',
  line: '#262b35',
  panel: '#14171d',
  dim: '#8a93a3',
  txt: '#e7eaf0',
};
