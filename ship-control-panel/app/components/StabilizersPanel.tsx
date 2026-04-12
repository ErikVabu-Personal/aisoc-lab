'use client';

import React, { useEffect, useMemo, useState } from 'react';

type Mode = 'OFF' | 'STANDBY' | 'AUTO' | 'MANUAL';

type Fin = {
  side: 'PORT' | 'STBD';
  angleDeg: number; // -25..25
};

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

export function StabilizersPanel() {
  const [mode, setMode] = useState<Mode>('AUTO');
  const [seaState, setSeaState] = useState(3); // 0..6
  const [rollDeg, setRollDeg] = useState(2.4);
  const [rollReduction, setRollReduction] = useState(62);
  const [fins, setFins] = useState<Fin[]>([
    { side: 'PORT', angleDeg: 4 },
    { side: 'STBD', angleDeg: -4 },
  ]);

  // Simulate roll and fin response
  useEffect(() => {
    const t = window.setInterval(() => {
      const baseRoll = mode === 'OFF' ? 7 : mode === 'STANDBY' ? 5 : 3;
      const wave = Math.sin(Date.now() / 900) * (1 + seaState / 4);
      const noise = (Math.random() - 0.5) * 0.6;
      const nextRoll = clamp(baseRoll + wave + noise, 0, 18);
      setRollDeg(nextRoll);

      if (mode === 'AUTO') {
        const target = clamp(-nextRoll * 1.2, -25, 25);
        setFins([
          { side: 'PORT', angleDeg: clamp(target, -25, 25) },
          { side: 'STBD', angleDeg: clamp(-target, -25, 25) },
        ]);
        setRollReduction(clamp(70 - nextRoll * 2.2 + (Math.random() - 0.5) * 6, 10, 95));
      } else if (mode === 'STANDBY') {
        setFins([
          { side: 'PORT', angleDeg: 0 },
          { side: 'STBD', angleDeg: 0 },
        ]);
        setRollReduction(clamp(20 - nextRoll * 0.8 + (Math.random() - 0.5) * 4, 0, 40));
      } else if (mode === 'OFF') {
        setFins([
          { side: 'PORT', angleDeg: 0 },
          { side: 'STBD', angleDeg: 0 },
        ]);
        setRollReduction(0);
      } else {
        // MANUAL: keep fins as user sets
        setRollReduction(clamp(35 - nextRoll * 1.2 + (Math.random() - 0.5) * 6, 0, 60));
      }
    }, 700);

    return () => window.clearInterval(t);
  }, [mode, seaState]);

  function setFin(side: 'PORT' | 'STBD', angleDeg: number) {
    setFins((prev) => prev.map((f) => (f.side === side ? { ...f, angleDeg } : f)));
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
                onClick={() => setMode(m)}
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
              onChange={(e) => setSeaState(parseInt(e.target.value, 10))}
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
