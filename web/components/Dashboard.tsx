'use client';

import { useEffect, useState } from 'react';
import { usePoll } from '@/lib/usePoll';
import RunControls from './RunControls';
import RunView from './RunView';
import LogSidebar from './LogSidebar';

export type Run = {
  runId: string;
  version?: string;
  slug?: string;
  rem?: number | null;
  continuousRemaining?: number | null;
  lastTick?: number | null;
};

export default function Dashboard() {
  const { data, error } = usePoll<Run[]>('/api/vm/runs');
  const runs = Array.isArray(data) ? data : [];
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  // Keep a valid selection: default to the first run, clear if it vanished.
  useEffect(() => {
    if (selectedRunId && !runs.some((r) => r.runId === selectedRunId)) {
      setSelectedRunId(runs[0]?.runId ?? null);
    } else if (!selectedRunId && runs.length) {
      setSelectedRunId(runs[0].runId);
    }
  }, [runs, selectedRunId]);

  async function stop(runId: string) {
    await fetch(`/api/vm/runs/${runId}`, { method: 'DELETE' });
    if (selectedRunId === runId) setSelectedRunId(null);
  }

  return (
    <main style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1 style={{ fontSize: 16, margin: 0 }}>61426 runner</h1>
        <button onClick={() => fetch('/api/logout', { method: 'POST' }).then(() => (window.location.href = '/login'))}>
          Sign out
        </button>
      </div>

      <RunControls runs={runs} selectedRunId={selectedRunId} onStarted={setSelectedRunId} onStop={stop} />

      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 420px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="panel">
            <strong>runs</strong>
            {error && <div className="bad">error: {error}</div>}
            {!runs.length && <div className="muted">no active runs</div>}
            {runs.map((r) => (
              <div key={r.runId} className="row" style={{ justifyContent: 'space-between' }}>
                <label className="row" style={{ gap: 6 }}>
                  <input
                    type="radio"
                    name="run"
                    checked={selectedRunId === r.runId}
                    onChange={() => setSelectedRunId(r.runId)}
                  />
                  <span>
                    {r.version} {r.slug}
                  </span>
                </label>
                <span className="muted">
                  rem={r.rem ?? '—'} cont={r.continuousRemaining ?? '—'}
                </span>
              </div>
            ))}
          </div>
          {selectedRunId && <RunView runId={selectedRunId} />}
        </div>
        <LogSidebar />
      </div>
    </main>
  );
}
