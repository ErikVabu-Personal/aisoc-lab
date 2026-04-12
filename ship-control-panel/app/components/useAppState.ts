'use client';

import { useCallback, useEffect, useState } from 'react';

type AppState = any;

export function useAppState() {
  const [state, setState] = useState<AppState | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    const res = await fetch('/api/state', { cache: 'no-store' });
    const json = await res.json();
    setState(json);
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const post = useCallback(async (action: string, payload: any) => {
    const res = await fetch('/api/state', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, payload }),
    });
    const json = await res.json();
    setState(json);
    return json;
  }, []);

  return { state, loading, refresh, post };
}
