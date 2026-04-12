'use client';

import React, { useEffect, useMemo } from 'react';
import { useAppState } from './useAppState';

type Mode = 'OFF' | 'STANDBY' | 'AUTO' | 'MANUAL';

type Fin = {
  side: 'PORT' | 'STBD';
  angleDeg: number; // -25..25
};

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

export function StabilizersPanel() {
  const { state, loading, post } = useAppState();

  const mode = (state?.stabilizers?.mode as Mode) ?? 'AUTO';
  const seaState = typeof state?.stabilizers?.seaState === 'number' ? state.stabilizers.seaState : 3;
  const fins: Fin[] = [
    { side: 'PORT', angleDeg: typeof state?.stabilizers?.finPortDeg === 'number' ? state.stabilizers.finPortDeg : 4 },
    { side: 'STBD', angleDeg: typeof state?.stabilizers?.finStbdDeg === 'number' ? state.stabilizers.finStbdDeg : -4 },
  ];

  // derived live indicators (still simulated client-side)
  const rollDeg = clamp(
    (mode === 'OFF' ? 7 : mode === 'STANDBY' ? 5 : 3) +
      Math.sin(Date.now() / 900) * (1 + seaState / 4) +
      (Math.random() - 0.5) * 0.6,
    0,
    18,
  );

  const rollReduction = clamp(
    mode === 'AUTO'
      ? 70 - rollDeg * 2.2 + (Math.random() - 0.5) * 6
      : mode === 'MANUAL'
        ? 35 - rollDeg * 1.2 + (Math.random() - 0.5) * 6
        : mode === 'STANDBY'
          ? 20 - rollDeg * 0.8 + (Math.random() - 0.5) * 4
          : 0,
    0,
    95,
  );

  // AUTO mode drives fin angles server-side; keep it gentle (demo)
  useEffect(() => {
    if (mode !== 'AUTO') return;
    const t = window.setInterval(() => {
      const baseRoll = 3;
      const wave = Math.sin(Date.now() / 900) * (1 + seaState / 4);
      const nextRoll = clamp(baseRoll + wave + (Math.random() - 0.5) * 0.6, 0, 18);
      const target = clamp(-nextRoll * 1.2, -25, 25);
      post('setStabilizers', { finPortDeg: clamp(target, -25, 25), finStbdDeg: clamp(-target, -25, 25) }).catch(() => {});
    }, 1200);
    return () => window.clearInterval(t);
  }, [mode, seaState, post]);

  function setFin(side: 'PORT' | 'STBD', angleDeg: number) {
    if (side === 'PORT') post('setStabilizers', { finPortDeg: angleDeg }).catch(() => {});
    else post('setStabilizers', { finStbdDeg: angleDeg }).catch(() => {});
  }

  const port = fins.find((f) => f.side === 'PORT')!;
  const stbd = fins.find((f) => f.side === 'STBD')!;

  const modePillClass = useMemo(() => {
    if (mode === 'AUTO') return 'pill mono ok';
    if (mode === 'MANUAL') return 'pill mono warn';
    if (mode === 'STANDBY') return 'pill mono';
    return 'pill mono danger';
  }, [mode]);

  return (
    <div className="kpi bigPanel">
      <div className="panelTitle">Stabilizers</div>

      <div className="nav" style={{ marginTop: 8 }}>
        <div className={modePillClass}>MODE: {mode}</div>
        <div className="pill mono">SEA: {seaState}/6</div>
        <div className="pill mono">ROLL: {rollDeg.toFixed(1)}°</div>
        <div className="pill mono">REDUCTION: {Math.round(rollReduction)}%</div>
      </div>

      <div className="stabGrid">
        <div className="stabCard">
          <div className="stabTitle">Control</div>
          <div className="stabModes">
            {(['OFF', 'STANDBY', 'AUTO', 'MANUAL'] as Mode[]).map((m) => (
              <button
                key={m}
                type="button"
                className={mode === m ? 'tab active' : 'tab'}
                onClick={() => post('setStabilizers', { mode: m }).catch(() => {})}
                disabled={loading}
              >
                {m}
              </button>
            ))}
          </div>

          <label className="ctl" style={{ gridTemplateColumns: '110px 1fr 70px' }}>
            <span>Sea state</span>
            <input
              type="range"
              min={0}
              max={6}
              value={seaState}
              onChange={(e) => post('setStabilizers', { seaState: parseInt(e.target.value, 10) }).catch(() => {})}
            />
            <span className="mono">{seaState}/6</span>
          </label>

          {mode === 'MANUAL' ? (
            <>
              <label className="ctl" style={{ gridTemplateColumns: '110px 1fr 70px' }}>
                <span>Port fin</span>
                <input
                  type="range"
                  min={-25}
                  max={25}
                  value={port.angleDeg}
                  onChange={(e) => setFin('PORT', parseInt(e.target.value, 10))}
                />
                <span className="mono">{port.angleDeg.toFixed(0)}°</span>
              </label>

              <label className="ctl" style={{ gridTemplateColumns: '110px 1fr 70px' }}>
                <span>Stbd fin</span>
                <input
                  type="range"
                  min={-25}
                  max={25}
                  value={stbd.angleDeg}
                  onChange={(e) => setFin('STBD', parseInt(e.target.value, 10))}
                />
                <span className="mono">{stbd.angleDeg.toFixed(0)}°</span>
              </label>
            </>
          ) : (
            <div className="sub" style={{ marginTop: 10 }}>
              Manual fin controls available in <b>MANUAL</b> mode.
            </div>
          )}
        </div>

        <div className="stabCard">
          <div className="stabTitle">Fin Angles</div>
          <div className="finRow">
            <div className="fin">
              <div className="finLabel">PORT</div>
              <div className="finGauge">
                <div className="finNeedle" style={{ transform: `rotate(${port.angleDeg * 3}deg)` }} />
              </div>
              <div className="mono">{port.angleDeg.toFixed(0)}°</div>
            </div>
            <div className="fin">
              <div className="finLabel">STBD</div>
              <div className="finGauge">
                <div className="finNeedle" style={{ transform: `rotate(${stbd.angleDeg * 3}deg)` }} />
              </div>
              <div className="mono">{stbd.angleDeg.toFixed(0)}°</div>
            </div>
          </div>

          <div className="sub" style={{ marginTop: 10, opacity: 0.8 }}>
            Typical indicators: mode, roll angle, fin angle (port/stbd), roll reduction.
          </div>
        </div>
      </div>
    </div>
  );
}
