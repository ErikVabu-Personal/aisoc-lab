'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useAppState } from './useAppState';

type Engine = {
  id: string;
  label: string;
  throttle: number; // 0..100
  temp: number; // C
  rpm: number;
  clutch: boolean;
  fuelMix: number; // 0..100 (bio/synth blend)
  alarm: 'NONE' | 'OVERHEAT' | 'OIL_PRESSURE' | 'VIBRATION';
};

type FuelTank = {
  id: string;
  label: string;
  level: number; // 0..100
};

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

function logEvent(event: string, detail: any) {
  console.log(
    JSON.stringify({
      time: new Date().toISOString(),
      service: 'ship-control-panel',
      event,
      detail,
    }),
  );
}

export function EngineRoomView() {
  const { state: app, loading, post } = useAppState();

  const [engines, setEngines] = useState<Engine[]>([
    { id: 'e1', label: 'Engine A', throttle: 62, temp: 420, rpm: 1880, clutch: true, fuelMix: 55, alarm: 'NONE' },
    { id: 'e2', label: 'Engine B', throttle: 62, temp: 418, rpm: 1875, clutch: true, fuelMix: 55, alarm: 'NONE' },
    { id: 'e3', label: 'Engine C', throttle: 58, temp: 405, rpm: 1760, clutch: true, fuelMix: 48, alarm: 'NONE' },
  ]);

  const [tanks, setTanks] = useState<FuelTank[]>([
    { id: 't1', label: 'Main Tank', level: 78 },
    { id: 't2', label: 'Reserve', level: 46 },
    { id: 't3', label: 'Day Tank', level: 64 },
  ]);

  // Light-theme surface for the engine-room canvas. Used to be a dark
  // hologram gradient; on the cruise-bridge skin it reads better as a
  // soft drafting-board panel matching the rest of the operations
  // surface.
  const bgStyle = useMemo(() => {
    return {
      background: 'var(--panel-2)',
      border: '1px solid var(--hairline)',
    } as React.CSSProperties;
  }, []);

  // Keep the Engine Room throttles in sync with Navigation throttle (single helm lever).
  const navThrottle = app?.navigation?.throttle ?? 35;
  useEffect(() => {
    setEngines((prev) =>
      prev.map((e) => {
        const thr = clamp(navThrottle, 0, 100);
        const rpm = Math.round(900 + (thr / 100) * 2100);
        const temp = Math.round(220 + (thr / 100) * 380 + (Math.random() - 0.5) * 8);
        const alarm: Engine['alarm'] = temp > 560 ? 'OVERHEAT' : 'NONE';
        return { ...e, throttle: thr, rpm, temp, alarm };
      }),
    );
  }, [navThrottle]);

  // Slowly consume fuel when moving (demo)
  useEffect(() => {
    const t = window.setInterval(() => {
      setTanks((prev) => {
        const burn = (navThrottle / 100) * 0.12;
        const next = prev.map((x, i) => {
          const factor = i === 0 ? 1 : i === 1 ? 0.4 : 0.7;
          return { ...x, level: clamp(x.level - burn * factor, 0, 100) };
        });
        return next;
      });
    }, 1500);
    return () => window.clearInterval(t);
  }, [navThrottle]);

  function setNavThrottle(v: number) {
    post('setThrottle', { throttle: clamp(v, 0, 100) }).catch(() => {});
  }

  function setEngine(id: string, patch: Partial<Engine>) {
    setEngines((prev) => prev.map((e) => (e.id === id ? { ...e, ...patch } : e)));

    if (typeof patch.clutch === 'boolean') {
      logEvent('engine.clutch', { engineId: id, clutch: patch.clutch });
    }
    if (typeof patch.fuelMix === 'number') {
      logEvent('engine.fuelMix', { engineId: id, fuelMix: patch.fuelMix });
    }
  }

  const anyAlarm = engines.some((e) => e.alarm !== 'NONE');

  return (
    <div className="view">
      <div className="viewTitle">Engine room</div>

      <div className="engineRoom" style={bgStyle}>
        <div className="engineGrid">
          <div className="engineCard" style={{ gridColumn: '1 / -1' }}>
            <div className="engineTop">
              <div className="engineName">Helm Link</div>
              <div className={anyAlarm ? 'pill mono warn' : 'pill mono'}>
                {anyAlarm ? 'ALERT' : 'NORMAL'}
              </div>
            </div>

            <label className="ctl" style={{ gridTemplateColumns: '140px 1fr 70px' }}>
              <span>Throttle</span>
              <input type="range" min={0} max={100} value={navThrottle} onChange={(e) => setNavThrottle(parseInt(e.target.value, 10))} disabled={loading} />
              <span className="mono">{navThrottle}%</span>
            </label>

            <div className="sub" style={{ marginTop: 10 }}>
              Propulsion throttle is shared with the Navigation console.
            </div>
          </div>

          <div className="engineCard" style={{ gridColumn: '1 / -1' }}>
            <div className="engineTop">
              <div className="engineName">Fuel Levels</div>
            </div>
            <div className="engineMetrics" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
              {tanks.map((t) => {
                const c = t.level > 60 ? 'rgba(52,211,153,0.90)' : t.level > 30 ? 'rgba(250,204,21,0.90)' : 'rgba(251,113,133,0.92)';
                return (
                  <div key={t.id} className="kpi">
                    <div className="kpiLabel">{t.label}</div>
                    <div className="bar" style={{ marginTop: 10 }}>
                      <div className="barFill" style={{ width: `${t.level}%`, background: c, boxShadow: `0 0 18px ${c.replace('0.90', '0.22').replace('0.92', '0.22')}` }} />
                    </div>
                    <div className="sub mono" style={{ marginTop: 6 }}>{t.level.toFixed(0)}%</div>
                  </div>
                );
              })}
            </div>
          </div>

          {engines.map((e) => (
            <div key={e.id} className="engineCard">
              <div className="engineTop">
                <div className="engineName">{e.label}</div>
                <div className={e.alarm === 'NONE' ? 'pill mono' : 'pill mono warn'}>
                  {e.alarm === 'NONE' ? 'OK' : e.alarm}
                </div>
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

              <div className="nav" style={{ marginTop: 8 }}>
                <button
                  type="button"
                  className={e.clutch ? 'toggle on' : 'toggle off'}
                  onClick={() => setEngine(e.id, { clutch: !e.clutch })}
                >
                  Clutch {e.clutch ? 'ENGAGED' : 'DISENGAGED'}
                </button>
              </div>

              <label className="ctl" style={{ marginTop: 8 }}>
                <span>Fuel mix</span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={e.fuelMix}
                  onChange={(ev) => setEngine(e.id, { fuelMix: clamp(parseInt(ev.target.value, 10), 0, 100) })}
                />
                <span className="mono">{e.fuelMix}%</span>
              </label>

              <div className="sub" style={{ marginTop: 8, opacity: 0.85 }}>
                Mix: {e.fuelMix}% synth / {100 - e.fuelMix}% bio
              </div>

              <div className="sub" style={{ marginTop: 8, opacity: 0.85 }}>
                Alarms: {e.alarm === 'NONE' ? 'None' : e.alarm}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
