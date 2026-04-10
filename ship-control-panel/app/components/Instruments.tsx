import React from 'react';

export function Gauge({
  label,
  value,
  min = 0,
  max = 100,
  unit,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  unit?: string;
}) {
  const clamped = Math.max(min, Math.min(max, value));
  const pct = (clamped - min) / (max - min);
  const start = -225;
  const sweep = 270;
  const angle = start + sweep * pct;

  const R = 46;
  const C = 2 * Math.PI * R;
  const arcPct = 0.75; // 270deg of 360
  const arcLen = C * arcPct;
  const dash = arcLen * pct;

  return (
    <div className="inst">
      <div className="instLabel">{label}</div>
      <div className="gWrap">
        <svg width="120" height="92" viewBox="0 0 120 92" aria-hidden>
          <defs>
            <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="rgba(34,211,238,0.95)" />
              <stop offset="1" stopColor="rgba(96,165,250,0.95)" />
            </linearGradient>
          </defs>
          <g transform="translate(60,56)">
            <circle r={R} fill="rgba(0,0,0,0.22)" stroke="rgba(255,255,255,0.08)" strokeWidth="1" />

            {/* track */}
            <circle
              r={R}
              fill="none"
              stroke="rgba(255,255,255,0.10)"
              strokeWidth="10"
              strokeLinecap="round"
              strokeDasharray={`${arcLen} ${C}`}
              strokeDashoffset={C * 0.125}
              transform="rotate(135)"
            />

            {/* value */}
            <circle
              r={R}
              fill="none"
              stroke="url(#g)"
              strokeWidth="10"
              strokeLinecap="round"
              strokeDasharray={`${dash} ${C}`}
              strokeDashoffset={C * 0.125}
              transform="rotate(135)"
            />

            {/* needle */}
            <g transform={`rotate(${angle})`}>
              <line x1="0" y1="0" x2={R - 8} y2="0" stroke="rgba(230,243,255,0.85)" strokeWidth="2" />
              <circle r="4" fill="rgba(230,243,255,0.9)" />
            </g>
          </g>
        </svg>
        <div className="gValue">
          <div className="gNum">
            {clamped.toFixed(0)}
            {unit ? <span className="gUnit">{unit}</span> : null}
          </div>
          <div className="gSub mono">{min}–{max}</div>
        </div>
      </div>
    </div>
  );
}

export function LockStatus({ label, locked }: { label: string; locked: boolean }) {
  return (
    <div className="inst">
      <div className="instLabel">{label}</div>
      <div className={locked ? 'lock locked' : 'lock unlocked'}>
        <div className="shackle" />
        <div className="body">
          <div className="keyhole" />
        </div>
      </div>
      <div className="gSub" style={{ marginTop: 6, opacity: 0.85 }}>
        {locked ? 'LOCKED' : 'UNLOCKED'}
      </div>
    </div>
  );
}

export function BarMeter({
  label,
  value,
  max = 100,
}: {
  label: string;
  value: number;
  max?: number;
}) {
  const pct = Math.max(0, Math.min(1, value / max));
  const color = pct > 0.85 ? 'rgba(52,211,153,0.9)' : pct > 0.6 ? 'rgba(34,211,238,0.9)' : 'rgba(251,113,133,0.9)';
  return (
    <div className="inst">
      <div className="instLabel">{label}</div>
      <div className="bar">
        <div className="barFill" style={{ width: `${pct * 100}%`, background: color }} />
      </div>
      <div className="gSub" style={{ marginTop: 6 }}>
        <span className="mono">{Math.round(value)}%</span>
      </div>
    </div>
  );
}

export function SeaState({ label, level }: { label: string; level: 'CALM' | 'MODERATE' | 'ROUGH' }) {
  const n = level === 'CALM' ? 1 : level === 'MODERATE' ? 3 : 5;
  return (
    <div className="inst">
      <div className="instLabel">{label}</div>
      <div className="waves" aria-hidden>
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className={i < n ? 'wave on' : 'wave'} />
        ))}
      </div>
      <div className="gSub" style={{ marginTop: 6, opacity: 0.85 }}>{level}</div>
    </div>
  );
}
