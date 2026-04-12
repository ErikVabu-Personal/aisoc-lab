'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useAppState } from './useAppState';

type FanMode = 'AUTO' | 'LOW' | 'MED' | 'HIGH';

type Room = {
  id: string;
  name: string;
  enabled: boolean;
  targetC: number;
  currentC: number;
  fan: FanMode;
};

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

export function ClimateView() {
  const { state, loading, post } = useAppState();

  // Local-only current temperature simulation; targets + switches are server-state.
  const [current, setCurrent] = useState<Record<string, number>>({
    Ballroom: 22.4,
    'Dining room': 20.8,
    Cabins: 19.6,
    Bridge: 21.0,
    'Engine room': 24.0,
  });

  const rooms: Room[] = [
    { id: 'ballroom', name: 'Ballroom', enabled: !!state?.climate?.rooms?.Ballroom?.enabled, targetC: state?.climate?.rooms?.Ballroom?.targetC ?? 21, currentC: current.Ballroom ?? 22.4, fan: (state?.climate?.rooms?.Ballroom?.fan as FanMode) ?? 'AUTO' },
    { id: 'dining', name: 'Dining room', enabled: !!state?.climate?.rooms?.['Dining room']?.enabled, targetC: state?.climate?.rooms?.['Dining room']?.targetC ?? 20, currentC: current['Dining room'] ?? 20.8, fan: (state?.climate?.rooms?.['Dining room']?.fan as FanMode) ?? 'AUTO' },
    { id: 'cabins', name: 'Cabins', enabled: !!state?.climate?.rooms?.Cabins?.enabled, targetC: state?.climate?.rooms?.Cabins?.targetC ?? 19, currentC: current.Cabins ?? 19.6, fan: (state?.climate?.rooms?.Cabins?.fan as FanMode) ?? 'AUTO' },
    { id: 'bridge', name: 'Bridge', enabled: !!state?.climate?.rooms?.Bridge?.enabled, targetC: state?.climate?.rooms?.Bridge?.targetC ?? 20, currentC: current.Bridge ?? 21.0, fan: (state?.climate?.rooms?.Bridge?.fan as FanMode) ?? 'AUTO' },
    { id: 'engine', name: 'Engine room', enabled: !!state?.climate?.rooms?.['Engine room']?.enabled, targetC: state?.climate?.rooms?.['Engine room']?.targetC ?? 18, currentC: current['Engine room'] ?? 24.0, fan: (state?.climate?.rooms?.['Engine room']?.fan as FanMode) ?? 'AUTO' },
  ];

  // Simulate temp drift toward target.
  useEffect(() => {
    const t = window.setInterval(() => {
      setCurrent((prev) => {
        const next: Record<string, number> = { ...prev };
        for (const r of rooms) {
          const cur = prev[r.name] ?? r.currentC;
          const drift = r.enabled ? (r.targetC - cur) * 0.05 : (22 - cur) * 0.02;
          const noise = (Math.random() - 0.5) * 0.05;
          next[r.name] = cur + drift + noise;
        }
        return next;
      });
    }, 800);
    return () => window.clearInterval(t);
  }, [rooms]);

  function update(roomName: string, patch: any) {
    post('setClimateRoom', { room: roomName, patch }).catch(() => {});
  }

  const summary = useMemo(() => {
    const on = rooms.filter((r) => r.enabled).length;
    const avg = rooms.reduce((a, r) => a + r.currentC, 0) / rooms.length;
    return { on, avg };
  }, [rooms]);

  return (
    <div className="view">
      <div className="viewTitle">Climate</div>
      <div className="viewSub">AC controls by room (simulated).</div>

      <div className="card" style={{ marginTop: 12 }}>
        <div className="nav" style={{ marginBottom: 10 }}>
          <div className="pill mono">Zones enabled: {summary.on}/{rooms.length}</div>
          <div className="pill mono">Avg temp: {summary.avg.toFixed(1)}°C</div>
        </div>

        <div className="engineGrid">
          {rooms.map((r) => (
            <div key={r.id} className="engineCard">
              <div className="engineTop">
                <div className="engineName">{r.name}</div>
                <button
                  type="button"
                  className={r.enabled ? 'toggle on' : 'toggle off'}
                  onClick={() => update(r.name, { enabled: !r.enabled })}
                  disabled={loading}
                >
                  {r.enabled ? 'ON' : 'OFF'}
                </button>
              </div>

              <div className="engineMetrics" style={{ gridTemplateColumns: '1fr 1fr' }}>
                <div className="kpi">
                  <div className="kpiLabel">Current</div>
                  <div className="kpiValue mono">{r.currentC.toFixed(1)}°C</div>
                </div>
                <div className="kpi">
                  <div className="kpiLabel">Target</div>
                  <div className="kpiValue mono">{r.targetC.toFixed(0)}°C</div>
                </div>
              </div>

              <label className="ctl">
                <span>Target</span>
                <input
                  type="range"
                  min={16}
                  max={26}
                  value={r.targetC}
                  onChange={(e) => update(r.name, { targetC: clamp(parseInt(e.target.value, 10), 16, 26) })}
                />
                <span className="mono">{r.targetC}°C</span>
              </label>

              <div className="nav" style={{ marginTop: 8 }}>
                <div className="sub">Fan</div>
                <select
                  className="input"
                  style={{ padding: '10px 10px', width: 150 }}
                  value={r.fan}
                  onChange={(e) => update(r.name, { fan: e.target.value as FanMode })}
                  disabled={loading}
                >
                  <option value="AUTO">AUTO</option>
                  <option value="LOW">LOW</option>
                  <option value="MED">MED</option>
                  <option value="HIGH">HIGH</option>
                </select>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
