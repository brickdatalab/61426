'use client';

import { useState } from 'react';
import type { Run } from './Dashboard';

const VERSIONS = ['v1', 'v2', 'v3', 'v5', 'v5.1', 'v5.2', 'v5.3', 'v5.4', 'v6'];

export default function RunControls({
  runs,
  selectedRunId,
  onStarted,
  onStop,
}: {
  runs: Run[];
  selectedRunId: string | null;
  onStarted: (runId: string) => void;
  onStop: (runId: string) => void;
}) {
  const [version, setVersion] = useState('v6');
  const [slug, setSlug] = useState('');
  const [continuous, setContinuous] = useState(0);
  const [ab, setAb] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function start() {
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/vm/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ version, slug, continuous, ab }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { runId?: string };
      if (data.runId) onStarted(data.runId);
    } catch (e) {
      setError(String((e as Error)?.message || e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className="row">
        <select value={version} onChange={(e) => setVersion(e.target.value)}>
          {VERSIONS.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
        <input
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          placeholder="slug (e.g. btc-updown-5m-…)"
          style={{ minWidth: 240 }}
        />
        <label className="row" style={{ gap: 4 }}>
          continuous
          <input
            type="number"
            value={continuous}
            min={0}
            onChange={(e) => setContinuous(Number(e.target.value) || 0)}
            style={{ width: 64 }}
          />
        </label>
        <label className="row" style={{ gap: 4 }}>
          <input type="checkbox" checked={ab} onChange={(e) => setAb(e.target.checked)} />
          A/B
        </label>
        <button onClick={start} disabled={busy || !slug}>
          {busy ? '…' : 'Start'}
        </button>
        <button onClick={() => selectedRunId && onStop(selectedRunId)} disabled={!selectedRunId}>
          Stop selected
        </button>
      </div>
      {error && <div className="bad">{error}</div>}
      <div className="muted">{runs.length} active run(s)</div>
    </div>
  );
}
