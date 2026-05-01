import React from 'react';

// Industrial-style circular gauge — designed to read like a real
// bridge or BMS instrument, not an arcade dial. Components:
//
//   - thin steel-blue progress arc (no gradient, no glow)
//   - tick ring with major + minor marks (270° sweep)
//   - centred mono digits, unit label below
//
// Sizing is set by viewBox so it scales cleanly inside flex/grid.
// Colours come from CSS variables so dark/light theme tweaks just
// work. The component is purely visual; the surrounding card pulls
// in label + descriptor text.

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

  const R = 44;                         // arc radius
  const C = 2 * Math.PI * R;            // full circumference
  const SWEEP_FRAC = 0.75;              // 270° of 360°
  const arcLen = C * SWEEP_FRAC;
  const dash = arcLen * pct;

  // 31 ticks across the 270° sweep — every 5th is "major".
  const TICKS = 31;

  return (
    <div className="inst">
      <div className="instLabel">{label}</div>
      <svg
        width="124"
        height="100"
        viewBox="0 0 124 100"
        aria-hidden
        style={{ display: 'block' }}
      >
        <g transform="translate(62, 58)">
          {/* Tick ring — sits just outside the arc. Drawn as 31 short
              radial segments rotated around centre. */}
          {Array.from({ length: TICKS }).map((_, i) => {
            const t = i / (TICKS - 1);
            const angle = -135 + t * 270;
            const major = i % 5 === 0;
            const inner = major ? R + 3 : R + 5;
            const outer = R + 9;
            const rad = (angle * Math.PI) / 180;
            const x1 = Math.cos(rad) * inner;
            const y1 = Math.sin(rad) * inner;
            const x2 = Math.cos(rad) * outer;
            const y2 = Math.sin(rad) * outer;
            return (
              <line
                key={i}
                x1={x1}
                y1={y1}
                x2={x2}
                y2={y2}
                stroke={major ? 'var(--text-soft)' : 'var(--hairline)'}
                strokeWidth={major ? 1.4 : 1}
              />
            );
          })}

          {/* Track arc — full sweep in hairline. */}
          <circle
            r={R}
            fill="none"
            stroke="var(--hairline)"
            strokeWidth="3"
            strokeLinecap="butt"
            strokeDasharray={`${arcLen} ${C}`}
            strokeDashoffset={C * 0.125}
            transform="rotate(135)"
          />

          {/* Value arc — single solid steel-blue, no gradient. */}
          <circle
            r={R}
            fill="none"
            stroke="var(--accent)"
            strokeWidth="3"
            strokeLinecap="butt"
            strokeDasharray={`${dash} ${C}`}
            strokeDashoffset={C * 0.125}
            transform="rotate(135)"
          />

          {/* Centre readout — monospace digits + unit. */}
          <text
            textAnchor="middle"
            x="0"
            y="3"
            fontFamily="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
            fontWeight="600"
            fontSize="22"
            fill="var(--text)"
            style={{ fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.02em' }}
          >
            {clamped.toFixed(0)}
          </text>
          {unit ? (
            <text
              textAnchor="middle"
              x="0"
              y="20"
              fontFamily="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
              fontWeight="500"
              fontSize="9.5"
              fill="var(--muted)"
              style={{ letterSpacing: '0.10em', textTransform: 'uppercase' }}
            >
              {unit}
            </text>
          ) : null}
        </g>
      </svg>
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
      <div className="gSub" style={{ marginTop: 8 }}>
        {locked ? 'Locked' : 'Unlocked'}
      </div>
    </div>
  );
}

// Bar meter — slim solid fill with semantic colour. Used on hull
// integrity, wind, depth, fuel level, etc. Below 30% reads red,
// 30–70% steel, above 70% green — matches the convention real
// bridge UIs use for "fuel / fuel-like" gauges.
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
  const color =
    pct > 0.7 ? 'var(--ok)' : pct > 0.3 ? 'var(--accent)' : 'var(--danger)';
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
  const display = level.charAt(0) + level.slice(1).toLowerCase();
  return (
    <div className="inst">
      <div className="instLabel">{label}</div>
      <div className="waves" aria-hidden>
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className={i < n ? 'wave on' : 'wave'} />
        ))}
      </div>
      <div className="gSub" style={{ marginTop: 6 }}>{display}</div>
    </div>
  );
}
