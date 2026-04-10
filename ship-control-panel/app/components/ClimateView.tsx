'use client';

import React, { useEffect, useMemo, useState } from 'react';

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
  const [rooms, setRooms] = useState<Room[]>([
    { id: 'ballroom', name: 'Ballroom', enabled: true, targetC: 21, currentC: 22.4, fan: 'AUTO' },
    { id: 'dining', name: 'Dining room', enabled: true, targetC: 20, currentC: 20.8, fan: 'LOW' },
    { id: 'cabins', name: 'Cabins', enabled: true, targetC: 19, currentC: 19.6, fan: 'AUTO' },
    { id: 'bridge', name: 'Bridge', enabled: true, targetC: 20, currentC: 21.0, fan: 'MED' },
    { id: 'engine', name: 'Engine room', enabled: true, targetC: 18, currentC: 24.0, fan: 'HIGH' },
  ]);

  // Simulate temp drift toward target.
  useEffect(() => {
    const t = window.setInterval(() => {
      setRooms((prev) =>
        prev.map((r) => {
          const drift = r.enabled ? (r.targetC - r.currentC) * 0.05 : (22 - r.currentC) * 0.02;
          const noise = (Math.random() - 0.5) * 0.05;
          return { ...r, currentC: r.currentC + drift + noise };
        }),
      );
    }, 800);
    return () => window.clearInterval(t);
  }, []);

  function update(id: string, patch: Partial<Room>) {
    setRooms((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
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
                  onClick={() => update(r.id, { enabled: !r.enabled })}
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
                  onChange={(e) => update(r.id, { targetC: clamp(parseInt(e.target.value, 10), 16, 26) })}
                />
                <span className="mono">{r.targetC}°C</span>
              </label>

              <div className="nav" style={{ marginTop: 8 }}>
                <div className="sub">Fan</div>
                <select
                  className="input"
                  style={{ padding: '10px 10px', width: 150 }}
                  value={r.fan}
                  onChange={(e) => update(r.id, { fan: e.target.value as FanMode })}
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
