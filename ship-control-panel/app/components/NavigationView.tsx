'use client';

import React, { useEffect, useMemo, useState } from 'react';

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

export function NavigationView() {
  const [heading, setHeading] = useState(271);
  const [speed, setSpeed] = useState(12.4);

  // simple wave animation
  const t = useNow(50);

  const shipStyle = useMemo(() => {
    const bob = Math.sin(t / 700) * 3;
    const sway = Math.sin(t / 900) * 2;
    return {
      transform: `translate(-50%, -50%) rotate(${heading}deg) translateY(${bob}px) rotate(${sway}deg)`,
    } as React.CSSProperties;
  }, [heading, t]);

  return (
    <div className="view">
      <div className="viewTitle">Navigation</div>
      <div className="viewSub">Sea chart (demo). Ship position is simulated and updates smoothly.</div>

      <div className="navGrid">
        <div className="sea">
          <div className="seaGrid" />
          <div className="seaWaves" />

          <div className="ship" style={shipStyle} title="AEGIR">
            <div className="shipBody" />
            <div className="shipNose" />
          </div>

          <div className="hud mono">
            <div>HDG {heading.toString().padStart(3, '0')}°</div>
            <div>SPD {speed.toFixed(1)} kn</div>
          </div>
        </div>

        <div className="panel">
          <div className="panelTitle">Helm</div>

          <label className="ctl">
            <span>Heading</span>
            <input
              type="range"
              min={0}
              max={359}
              value={heading}
              onChange={(e) => setHeading(parseInt(e.target.value, 10))}
            />
            <span className="mono">{heading}°</span>
          </label>

          <label className="ctl">
            <span>Speed</span>
            <input
              type="range"
              min={0}
              max={35}
              step={0.1}
              value={speed}
              onChange={(e) => setSpeed(clamp(parseFloat(e.target.value), 0, 35))}
            />
            <span className="mono">{speed.toFixed(1)} kn</span>
          </label>

          <div className="hint">Tip: this will later be replaced with real nav data / map tiles.</div>
        </div>
      </div>
    </div>
  );
}

function useNow(ms: number) {
  const [n, setN] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setN(Date.now()), ms);
    return () => window.clearInterval(t);
  }, [ms]);
  return n;
}
