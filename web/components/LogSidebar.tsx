'use client';

import Link from 'next/link';
import { usePoll } from '@/lib/usePoll';

type LogEntry = {
  version: string;
  slug: string;
  settled?: boolean | null;
  n?: number | null;
  mtime?: number | null;
};

export default function LogSidebar() {
  const { data, error, loading } = usePoll<LogEntry[]>('/api/vm/logs', 5000);
  const logs = Array.isArray(data) ? data : [];

  const byVersion = new Map<string, LogEntry[]>();
  for (const l of logs) {
    const key = l.version || '?';
    const arr = byVersion.get(key) || [];
    arr.push(l);
    byVersion.set(key, arr);
  }
  const versions = Array.from(byVersion.keys()).sort();

  return (
    <div className="panel" style={{ minWidth: 240 }}>
      <strong>logs</strong>
      {error && <div className="bad">error: {error}</div>}
      {loading && !logs.length && <div className="muted">loading…</div>}
      {!loading && !logs.length && !error && <div className="muted">no logs</div>}
      {versions.map((v) => (
        <div key={v} style={{ marginTop: 8 }}>
          <div className="muted">{v}</div>
          {(byVersion.get(v) || []).map((l, i) => (
            <div key={`${l.slug}-${i}`} className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
              <Link href={`/log/${encodeURIComponent(`${l.slug}_${l.version}`)}`} title={l.slug} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 150 }}>
                {l.slug}
              </Link>
              <span className={l.settled ? 'good' : 'muted'}>
                {l.settled ? 'settled' : 'live'} n={l.n ?? '—'}
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
