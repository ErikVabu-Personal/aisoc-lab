'use client';

import React, { useMemo, useState } from 'react';

type Engine = {
  id: string;
  label: string;
  throttle: number; // 0..100
  temp: number; // C
  rpm: number;
};

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

export function EngineRoomView() {
  const [engines, setEngines] = useState<Engine[]>([
    { id: 'e1', label: 'Engine A', throttle: 62, temp: 420, rpm: 1880 },
    { id: 'e2', label: 'Engine B', throttle: 62, temp: 418, rpm: 1875 },
    { id: 'e3', label: 'Engine C', throttle: 58, temp: 405, rpm: 1760 },
  ]);

  const bgStyle = useMemo(() => {
    // cheap "engine room" background using gradients (no external images)
    return {
      background:
        'radial-gradient(900px 420px at 20% 20%, rgba(255,255,255,0.10), transparent 55%),' +
        'radial-gradient(700px 380px at 80% 30%, rgba(34,211,238,0.10), transparent 55%),' +
        'linear-gradient(180deg, rgba(0,0,0,0.28), rgba(0,0,0,0.65))',
    } as React.CSSProperties;
  }, []);

  function update(id: string, patch: Partial<Engine>) {
    setEngines((prev) =>
      prev.map((e) => {
        if (e.id !== id) return e;
        const next = { ...e, ...patch };
        // derive simple simulated values
        next.rpm = Math.round(900 + (next.throttle / 100) * 2100);
        next.temp = Math.round(220 + (next.throttle / 100) * 380);
        return next;
      }),
    );
  }

  return (
    <div className="view">
      <div className="viewTitle">Engine room</div>
      <div className="viewSub">Simulated engine controls. Each lever updates RPM and temperature.</div>

      <div className="engineRoom" style={bgStyle}>
        <div className="engineGrid">
          {engines.map((e) => (
            <div key={e.id} className="engineCard">
              <div className="engineTop">
                <div className="engineName">{e.label}</div>
                <div className="pill mono">THR {e.throttle.toFixed(0)}%</div>
              </div>

              <div className="engineMetrics">
                <div className="kpi">
                  <div className="kpiLabel">RPM</div>
                  <div className="kpiValue mono">{e.rpm}</div>
                </div>
                <div className="kpi">
                  <div className="kpiLabel">TEMP</div>
                  <div className="kpiValue mono">{e.temp}°C</div>
                </div>
              </div>

              <label className="ctl">
                <span>Throttle</span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={e.throttle}
                  onChange={(ev) => update(e.id, { throttle: clamp(parseInt(ev.target.value, 10), 0, 100) })}
                />
                <span className="mono">{e.throttle.toFixed(0)}%</span>
              </label>

              <div className="hint">(placeholder) Later: fuel mix, clutch, alarms.</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
