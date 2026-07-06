'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePoll } from '@/lib/usePoll';
import LogSidebar from './LogSidebar';

export type Run = {
  runId: string;
  version?: string;
  slug?: string;
  rem?: number | null;
  continuousRemaining?: number | null;
  lastTick?: number | null;
};

const VERSIONS = ['v1', 'v2', 'v3', 'v5', 'v5.1', 'v5.2', 'v5.3', 'v5.4', 'v6'];
const INTERVALS = ['5m', '15m', '1h'];

function intervalSec(iv: string): number {
  const m = iv.match(/^(\d+)([mh])$/);
  if (!m) return 300;
  return Number(m[1]) * (m[2] === 'h' ? 3600 : 60);
}

export default function Dashboard() {
  const { data, error } = usePoll<Run[]>('/api/vm/runs');
  const runs = Array.isArray(data) ? data : [];

  const [version, setVersion] = useState('v6');
  const [asset, setAsset] = useState('BTC');
  const [interval, setInterval] = useState('5m');
  const [continuous, setContinuous] = useState(1);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');

  async function start() {
    setBusy(true);
    setFormError('');
    try {
      const secs = intervalSec(interval);
      const barEpoch = Math.floor(Date.now() / (secs * 1000)) * secs;
      const slug = `${asset.toLowerCase()}-updown-${interval}-${barEpoch}`;
      const res = await fetch('/api/vm/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ version, slug, continuous, ab: false }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      setFormError(String((e as Error)?.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function stop(runId: string) {
    await fetch(`/api/vm/runs/${runId}`, { method: 'DELETE' });
  }

  return (
    <main style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1 style={{ fontSize: 16, margin: 0 }}>61426 runner</h1>
        <button onClick={() => fetch('/api/logout', { method: 'POST' }).then(() => (window.location.href = '/login'))}>
          Sign out
        </button>
      </div>

      <div className="panel row">
        <select value={version} onChange={(e) => setVersion(e.target.value)}>
          {VERSIONS.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
        <select value={asset} onChange={(e) => setAsset(e.target.value)}>
          <option value="BTC">BTC</option>
          <option value="ETH">ETH</option>
        </select>
        <select value={interval} onChange={(e) => setInterval(e.target.value)}>
          {INTERVALS.map((iv) => (
            <option key={iv} value={iv}>
              {iv}
            </option>
          ))}
        </select>
        <label className="row" style={{ gap: 4 }}>
          continuous
          <input
            type="number"
            value={continuous}
            min={1}
            max={50}
            onChange={(e) => setContinuous(Math.max(1, Number(e.target.value) || 1))}
            style={{ width: 64 }}
          />
        </label>
        <button onClick={start} disabled={busy}>
          {busy ? '…' : 'Start run'}
        </button>
        {formError && <span className="bad">{formError}</span>}
      </div>

      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 420px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="panel">
            <strong>runs</strong>
            {error && <div className="bad">error: {error}</div>}
            {!runs.length && <div className="muted">no active runs</div>}
            {runs.map((r) => (
              <div key={r.runId} className="row" style={{ justifyContent: 'space-between' }}>
                <Link href={`/run/${r.runId}`}>
                  {r.version} <span className="mono">{r.slug}</span>
                </Link>
                <span className="row" style={{ gap: 10 }}>
                  <span className="muted">
                    rem={r.rem ?? '—'} cont={r.continuousRemaining ?? '—'}
                  </span>
                  <button onClick={() => stop(r.runId)}>Stop</button>
                </span>
              </div>
            ))}
          </div>
        </div>
        <LogSidebar />
      </div>
    </main>
  );
}
