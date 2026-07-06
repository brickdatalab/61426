'use client';

import { useEffect, useRef } from 'react';
import { COLORS } from './types';

export type Series = { values: (number | null)[]; color: string };

// Plain HTML5 <canvas> line/area plot. Auto-scales Y across all series, draws a
// zero baseline, and fills the area between line and zero (like the v6 panels).
// No chart library — read-only, redraws whenever `series` changes.
export default function LineCanvas({ series, height = 250 }: { series: Series[]; height?: number }) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const parent = canvas.parentElement;
    const cssW = parent ? parent.clientWidth : 600;
    const cssH = height;
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    canvas.width = Math.max(1, Math.floor(cssW * dpr));
    canvas.height = Math.max(1, Math.floor(cssH * dpr));
    canvas.style.width = '100%';
    canvas.style.height = cssH + 'px';
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const padL = 6;
    const padR = 6;
    const padT = 10;
    const padB = 10;
    const plotW = cssW - padL - padR;
    const plotH = cssH - padT - padB;

    // collect finite values for y-range
    const all: number[] = [];
    for (const s of series) for (const v of s.values) if (v != null && Number.isFinite(v)) all.push(v);
    if (!all.length) {
      ctx.fillStyle = COLORS.dim;
      ctx.font = '11px ui-monospace, monospace';
      ctx.fillText('no data', padL, cssH / 2);
      return;
    }
    let mn = Math.min(...all, 0);
    let mx = Math.max(...all, 0);
    if (mn === mx) { mn -= 1; mx += 1; }
    const maxLen = Math.max(...series.map((s) => s.values.length), 2);

    const x = (i: number) => padL + (maxLen <= 1 ? 0 : (i / (maxLen - 1)) * plotW);
    const y = (v: number) => padT + (1 - (v - mn) / (mx - mn)) * plotH;

    // zero baseline
    const zeroY = y(0);
    ctx.strokeStyle = 'rgba(255,255,255,0.28)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(padL, zeroY);
    ctx.lineTo(padL + plotW, zeroY);
    ctx.stroke();
    ctx.setLineDash([]);

    for (const s of series) {
      // area fill to zero
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < s.values.length; i++) {
        const v = s.values[i];
        if (v == null || !Number.isFinite(v)) { started = false; continue; }
        const px = x(i);
        const py = y(v);
        if (!started) { ctx.moveTo(px, zeroY); ctx.lineTo(px, py); started = true; }
        else ctx.lineTo(px, py);
      }
      if (started) {
        // close down to zero at the last drawn x
        const lastIdx = (() => { for (let i = s.values.length - 1; i >= 0; i--) { const v = s.values[i]; if (v != null && Number.isFinite(v)) return i; } return -1; })();
        if (lastIdx >= 0) ctx.lineTo(x(lastIdx), zeroY);
        ctx.closePath();
        ctx.fillStyle = hexToRgba(s.color, 0.12);
        ctx.fill();
      }
      // line
      ctx.beginPath();
      let move = true;
      for (let i = 0; i < s.values.length; i++) {
        const v = s.values[i];
        if (v == null || !Number.isFinite(v)) { move = true; continue; }
        const px = x(i);
        const py = y(v);
        if (move) { ctx.moveTo(px, py); move = false; } else ctx.lineTo(px, py);
      }
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }, [series, height]);

  return <canvas ref={ref} />;
}

function hexToRgba(hex: string, a: number): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}
