'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function LoginPage() {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        const data = (await res.json()) as { ok?: boolean };
        if (data.ok) {
          router.push('/');
          return;
        }
      }
      if (res.status === 429) setError('Too many attempts. Wait a minute.');
      else setError('Wrong password.');
    } catch {
      setError('Network error.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ maxWidth: 340, margin: '80px auto', padding: '0 16px' }}>
      <h1 style={{ fontSize: 16 }}>61426 runner</h1>
      <form onSubmit={submit} className="panel" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="password"
          autoFocus
        />
        <button type="submit" disabled={busy}>
          {busy ? '…' : 'Sign in'}
        </button>
        {error && <div className="bad">{error}</div>}
      </form>
    </main>
  );
}
