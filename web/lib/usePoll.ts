'use client';

import { useEffect, useRef, useState } from 'react';

export type PollState<T> = { data: T | null; error: string | null; loading: boolean };

// Polls `url` every intervalMs. Pauses while the tab is hidden and resumes on
// visibilitychange. Cleans up the interval + listener on unmount / url change.
export function usePoll<T>(url: string, intervalMs = 1500): PollState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function tick() {
      if (typeof document !== 'undefined' && document.hidden) return;
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as T;
        if (!cancelled) {
          setData(json);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(String((e as Error)?.message || e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    function start() {
      if (timer.current) return;
      tick();
      timer.current = setInterval(tick, intervalMs);
    }
    function stop() {
      if (timer.current) {
        clearInterval(timer.current);
        timer.current = null;
      }
    }
    function onVis() {
      if (document.hidden) stop();
      else start();
    }

    start();
    document.addEventListener('visibilitychange', onVis);

    return () => {
      cancelled = true;
      stop();
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [url, intervalMs]);

  return { data, error, loading };
}
